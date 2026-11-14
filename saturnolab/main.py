from __future__ import annotations

import asyncio
import json
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, Query, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, HTMLResponse
from fastapi.staticfiles import StaticFiles
from starlette.concurrency import run_in_threadpool
from pydantic import BaseModel

from . import __version__, fs_service
from .config import config_manager
from .kernel_manager import kernel_registry
from .llm_service import stream_inline_generation, strip_markdown_fences


@asynccontextmanager
async def lifespan(_app: FastAPI):
    yield
    await kernel_registry.shutdown_all()


# Preserve serialized filesystem operations (including read/write ordering),
# while allowing the event loop to serve kernel messages and other endpoints.
filesystem_lock = asyncio.Lock()


async def run_filesystem(operation, *args, **kwargs):
    async with filesystem_lock:
        return await run_in_threadpool(operation, *args, **kwargs)


app = FastAPI(title="SaturnoLab", version=__version__, lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class WorkspaceSwitchRequest(BaseModel):
    path: str


class SaveNotebookRequest(BaseModel):
    path: str
    cells: list[dict[str, Any]]
    metadata: dict[str, Any] | None = None


class CreateNotebookRequest(BaseModel):
    folder: str = ""
    name: str | None = None


class CreateFolderRequest(BaseModel):
    folder: str = ""
    name: str


class RenameRequest(BaseModel):
    old_path: str
    new_name: str


class SaveFileRequest(BaseModel):
    path: str
    content: str


class CreateFileRequest(BaseModel):
    folder: str = ""
    name: str = "script.py"


class MoveEntriesRequest(BaseModel):
    paths: list[str]
    target_folder: str = ""


class DeleteBatchRequest(BaseModel):
    paths: list[str]


class KernelActionRequest(BaseModel):
    notebook_path: str


@app.get("/api/health")
async def health() -> dict[str, Any]:
    return {
        "status": "ok",
        "version": __version__,
        "workspace": str(config_manager.get_workspace_path()),
    }


@app.get("/api/config")
async def get_config() -> dict[str, Any]:
    return config_manager.public_dict()


@app.put("/api/config")
async def update_config(patch: dict[str, Any]) -> dict[str, Any]:
    config_manager.update_settings(patch)
    return config_manager.public_dict()


@app.get("/api/system/dirs")
async def browse_system_dirs(path: str = Query(default="")) -> dict[str, Any]:
    base = (
        Path(path).expanduser().resolve()
        if path.strip()
        else config_manager.get_workspace_path()
    )
    if not base.exists() or not base.is_dir():
        base = Path.home().resolve()
    subdirs: list[dict[str, str]] = []
    try:
        for entry in sorted(base.iterdir(), key=lambda e: e.name.lower()):
            if entry.name.startswith("."):
                continue
            if entry.is_dir():
                subdirs.append({"name": entry.name, "path": str(entry.resolve())})
    except PermissionError:
        pass
    parent = str(base.parent.resolve()) if base.parent != base else None
    return {
        "current": str(base),
        "parent": parent,
        "home": str(Path.home().resolve()),
        "directories": subdirs,
    }


@app.post("/api/workspace")
async def switch_workspace(req: WorkspaceSwitchRequest) -> dict[str, Any]:
    try:
        await kernel_registry.shutdown_all()
        new_ws = config_manager.set_workspace_path(req.path)
        return {
            "workspace_root": str(new_ws),
            "listing": await run_filesystem(fs_service.list_directory, new_ws, ""),
        }
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.get("/api/fs/list")
async def api_list_dir(
    path: str = Query(default=""), recursive: bool = Query(default=False)
) -> dict[str, Any]:
    try:
        return await run_filesystem(
            fs_service.list_directory,
            config_manager.get_workspace_path(), path, recursive=recursive
        )
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except (PermissionError, ValueError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.get("/api/fs/notebook")
async def api_read_notebook(path: str = Query(...)) -> dict[str, Any]:
    try:
        ws = config_manager.get_workspace_path()
        nb = await run_filesystem(fs_service.read_notebook, ws, path)
        existing = kernel_registry.get_existing(ws, nb["path"])
        nb["kernel_status"] = existing.status if existing else "not_started"
        nb["variables"] = existing.variables_cache if existing else []
        return nb
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/api/fs/notebook/save")
async def api_save_notebook(req: SaveNotebookRequest) -> dict[str, Any]:
    try:
        return await run_filesystem(
            fs_service.save_notebook,
            config_manager.get_workspace_path(),
            req.path,
            req.cells,
            req.metadata,
        )
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/api/fs/notebook/create")
async def api_create_notebook(req: CreateNotebookRequest) -> dict[str, Any]:
    try:
        return await run_filesystem(
            fs_service.create_notebook,
            config_manager.get_workspace_path(),
            req.folder,
            req.name,
        )
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/api/fs/folder/create")
async def api_create_folder(req: CreateFolderRequest) -> dict[str, Any]:
    try:
        return await run_filesystem(
            fs_service.create_folder,
            config_manager.get_workspace_path(),
            req.folder,
            req.name,
        )
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/api/fs/rename")
async def api_rename(req: RenameRequest) -> dict[str, Any]:
    try:
        ws = config_manager.get_workspace_path()
        await kernel_registry.shutdown_notebook(ws, req.old_path)
        return await run_filesystem(fs_service.rename_entry, ws, req.old_path, req.new_name)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.delete("/api/fs/entry")
async def api_delete(path: str = Query(...)) -> dict[str, Any]:
    try:
        ws = config_manager.get_workspace_path()
        await kernel_registry.shutdown_notebook(ws, path)
        return await run_filesystem(fs_service.delete_entry, ws, path)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.get("/api/fs/file")
async def api_read_file(path: str = Query(...)) -> dict[str, Any]:
    try:
        return await run_filesystem(fs_service.read_text_file, config_manager.get_workspace_path(), path)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/api/fs/file/save")
async def api_save_file(req: SaveFileRequest) -> dict[str, Any]:
    try:
        return await run_filesystem(
            fs_service.write_text_file,
            config_manager.get_workspace_path(), req.path, req.content
        )
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/api/fs/file/create")
async def api_create_file(req: CreateFileRequest) -> dict[str, Any]:
    try:
        return await run_filesystem(
            fs_service.create_text_file,
            config_manager.get_workspace_path(), req.folder, req.name
        )
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/api/fs/copy")
async def api_copy_entries(req: MoveEntriesRequest) -> dict[str, Any]:
    try:
        return await run_filesystem(fs_service.copy_entries, config_manager.get_workspace_path(), req.paths, req.target_folder)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/api/fs/move")
async def api_move_entries(req: MoveEntriesRequest) -> dict[str, Any]:
    try:
        ws = config_manager.get_workspace_path()
        planned = await run_filesystem(fs_service.plan_move_entries, ws, req.paths, req.target_folder)
        for _, _, path in planned:
            await kernel_registry.shutdown_notebook(ws, path)
        return await run_filesystem(fs_service.move_entries, ws, req.paths, req.target_folder)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/api/fs/delete-batch")
async def api_delete_batch(req: DeleteBatchRequest) -> dict[str, Any]:
    try:
        ws = config_manager.get_workspace_path()
        for p in req.paths:
            await kernel_registry.shutdown_notebook(ws, p)
        return await run_filesystem(fs_service.delete_entries, ws, req.paths)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.get("/api/kernels")
async def api_list_kernels() -> dict[str, Any]:
    return {"kernels": kernel_registry.list_active()}


@app.post("/api/kernels/start")
async def api_start_kernel(req: KernelActionRequest) -> dict[str, Any]:
    ws = config_manager.get_workspace_path()
    session = await kernel_registry.get_or_create(ws, req.notebook_path)
    return {
        "notebook_path": req.notebook_path,
        "status": session.status,
        "python_executable": session.python_exe,
        "variables": session.variables_cache,
    }


@app.post("/api/kernels/interrupt")
async def api_interrupt_kernel(req: KernelActionRequest) -> dict[str, Any]:
    ws = config_manager.get_workspace_path()
    session = kernel_registry.get_existing(ws, req.notebook_path)
    if session:
        await session.interrupt()
    return {"interrupted": True, "notebook_path": req.notebook_path}


@app.post("/api/kernels/restart")
async def api_restart_kernel(req: KernelActionRequest) -> dict[str, Any]:
    ws = config_manager.get_workspace_path()
    session = kernel_registry.get_existing(ws, req.notebook_path)
    if session:
        await session.restart()
    else:
        session = await kernel_registry.get_or_create(ws, req.notebook_path)
    return {"restarted": True, "notebook_path": req.notebook_path, "status": session.status}


@app.post("/api/kernels/shutdown")
async def api_shutdown_kernel(req: KernelActionRequest) -> dict[str, Any]:
    ws = config_manager.get_workspace_path()
    await kernel_registry.shutdown_notebook(ws, req.notebook_path)
    return {"shutdown": True, "notebook_path": req.notebook_path}


@app.websocket("/ws")
async def websocket_endpoint(ws: WebSocket) -> None:
    await ws.accept()
    send_lock = asyncio.Lock()
    ai_tasks: dict[str, asyncio.Task[Any]] = {}
    exec_tasks: set[asyncio.Task[Any]] = set()

    async def safe_send(payload: dict[str, Any]) -> None:
        try:
            async with send_lock:
                await ws.send_json(payload)
        except Exception:
            pass

    async def handle_execute(msg: dict[str, Any]) -> None:
        nb_path = msg.get("notebook_path", "")
        cell_id = msg.get("cell_id", "")
        code = msg.get("code", "")
        if not nb_path or not cell_id:
            return
        try:
            workspace_root = config_manager.get_workspace_path()
            session = await kernel_registry.get_or_create(workspace_root, nb_path)
            await session.execute_cell(cell_id=cell_id, code=code, on_event=safe_send)
        except Exception as exc:
            await safe_send(
                {
                    "type": "cell_output",
                    "notebook_path": nb_path,
                    "cell_id": cell_id,
                    "output": {
                        "output_type": "error",
                        "ename": "KernelError",
                        "evalue": str(exc),
                        "traceback": [str(exc)],
                    },
                }
            )
            await safe_send(
                {
                    "type": "cell_execution_done",
                    "notebook_path": nb_path,
                    "cell_id": cell_id,
                    "execution_count": None,
                    "variables": [],
                }
            )

    async def handle_ai_generate(msg: dict[str, Any]) -> None:
        request_id = msg.get("request_id", "")
        cell_id = msg.get("cell_id", "")
        nb_path = msg.get("notebook_path", "")
        cell_type = msg.get("cell_type", "code")
        workspace_root = config_manager.get_workspace_path()
        existing_session = (
            kernel_registry.get_existing(workspace_root, nb_path) if nb_path else None
        )
        kernel_vars = existing_session.variables_cache if existing_session else []

        accumulated: list[str] = []
        try:
            await safe_send(
                {
                    "type": "ai_start",
                    "request_id": request_id,
                    "cell_id": cell_id,
                }
            )
            async for delta in stream_inline_generation(msg, kernel_vars, workspace_root):
                accumulated.append(delta)
                await safe_send(
                    {
                        "type": "ai_chunk",
                        "request_id": request_id,
                        "cell_id": cell_id,
                        "delta": delta,
                    }
                )
            final_code = strip_markdown_fences("".join(accumulated), cell_type=cell_type)
            await safe_send(
                {
                    "type": "ai_done",
                    "request_id": request_id,
                    "cell_id": cell_id,
                    "code": final_code,
                }
            )
        except asyncio.CancelledError:
            await safe_send(
                {
                    "type": "ai_cancelled",
                    "request_id": request_id,
                    "cell_id": cell_id,
                }
            )
        except Exception as exc:
            await safe_send(
                {
                    "type": "ai_error",
                    "request_id": request_id,
                    "cell_id": cell_id,
                    "message": str(exc),
                }
            )
        finally:
            ai_tasks.pop(request_id, None)

    try:
        while True:
            data = await ws.receive_json()
            action = data.get("action")

            if action == "execute_cell":
                t = asyncio.create_task(handle_execute(data))
                exec_tasks.add(t)
                t.add_done_callback(exec_tasks.discard)

            elif action == "interrupt_kernel":
                nb_path = data.get("notebook_path", "")
                session = kernel_registry.get_existing(
                    config_manager.get_workspace_path(), nb_path
                )
                if session:
                    await session.interrupt()

            elif action == "ai_generate":
                req_id = data.get("request_id", "default")
                if req_id in ai_tasks:
                    ai_tasks[req_id].cancel()
                ai_tasks[req_id] = asyncio.create_task(handle_ai_generate(data))

            elif action == "ai_cancel":
                req_id = data.get("request_id", "default")
                task = ai_tasks.pop(req_id, None)
                if task:
                    task.cancel()

            elif action == "ping":
                await safe_send({"type": "pong"})

    except WebSocketDisconnect:
        pass
    finally:
        for t in list(ai_tasks.values()):
            t.cancel()


# Serve bundled SPA from inside `saturnolab/static`
STATIC_DIR = Path(__file__).resolve().parent / "static"
if (STATIC_DIR / "assets").exists():
    app.mount("/assets", StaticFiles(directory=str(STATIC_DIR / "assets")), name="assets")


@app.get("/{full_path:path}", response_model=None)
async def serve_spa(full_path: str):
    if STATIC_DIR.exists():
        candidate = (STATIC_DIR / full_path).resolve()
        if full_path and candidate.name != "index.html" and candidate.is_file() and STATIC_DIR.resolve() in candidate.parents:
            return FileResponse(str(candidate))
        index_file = STATIC_DIR / "index.html"
        if index_file.is_file():
            # Supply only UI settings, so the first render has the final geometry.
            cfg = config_manager.config
            fields = (
                "theme", "active_provider", "include_kernel_variables", "notebook_layout",
                "sidebar_position", "sidebar_width", "editor_font_size", "show_line_numbers",
                "auto_scroll_on_run", "show_modified_time", "confirm_kernel_restart", "output_display",
            )
            bootstrap = {field: getattr(cfg, field) for field in fields}
            bootstrap.update(workspace_dir=str(config_manager.get_workspace_path()), providers={})
            payload = json.dumps(bootstrap).replace("<", "\\u003c")
            html = await run_in_threadpool(index_file.read_text, encoding="utf-8")
            html = html.replace("</head>", f"<script>window.__SATURNO_BOOTSTRAP__={payload};</script></head>")
            return HTMLResponse(html, headers={"Cache-Control": "no-store"})
    return HTMLResponse(
        "<h3>SaturnoLab frontend static assets not built yet. Run <code>npm run build</code> in <code>frontend/</code>.</h3>",
        status_code=503,
    )
