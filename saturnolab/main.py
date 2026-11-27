from __future__ import annotations

import asyncio
import json
import re
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

from fastapi import FastAPI, HTTPException, Query, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse, HTMLResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from starlette.concurrency import run_in_threadpool

from . import __version__, fs_service
from .config import config_manager
from .kernel_manager import (
    _build_completion_payload,
    _jedi_complete_fallback,
    _jedi_inspect_fallback,
    kernel_registry,
)
from .llm_service import close_http_client, stream_inline_generation, strip_markdown_fences

_LOCAL_ORIGIN_RE = re.compile(r"^https?://(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$", re.IGNORECASE)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    yield
    await kernel_registry.shutdown_all()
    await close_http_client()


class _FilesystemLockCoordinator:
    """Per-path write locks + structural tree lock without blocking atomic file reads."""

    def __init__(self) -> None:
        self._loop: asyncio.AbstractEventLoop | None = None
        self._structural_lock: asyncio.Lock | None = None
        self._path_locks: dict[str, asyncio.Lock] = {}

    def _ensure_loop(self) -> asyncio.Lock:
        loop = asyncio.get_running_loop()
        if self._structural_lock is None or self._loop is not loop:
            self._loop = loop
            self._structural_lock = asyncio.Lock()
            self._path_locks.clear()
        return self._structural_lock

    @asynccontextmanager
    async def write_file(self, key: str):
        self._ensure_loop()
        if len(self._path_locks) > 512:
            # Prune idle path locks to bound memory
            for k in [k for k, lk in self._path_locks.items() if not lk.locked()]:
                self._path_locks.pop(k, None)
        path_lock = self._path_locks.setdefault(key, asyncio.Lock())
        async with path_lock:
            yield

    @asynccontextmanager
    async def structural_write(self):
        structural_lock = self._ensure_loop()
        async with structural_lock:
            yield


fs_locks = _FilesystemLockCoordinator()


async def run_fs_read(operation, *args, **kwargs):
    # Reads never observe half-written files because writes use mkstemp + atomic os.replace.
    return await run_in_threadpool(operation, *args, **kwargs)


async def run_fs_file_write(path_key: str, operation, *args, **kwargs):
    async with fs_locks.write_file(path_key):
        return await run_in_threadpool(operation, *args, **kwargs)


async def run_fs_write(operation, *args, **kwargs):
    async with fs_locks.structural_write():
        return await run_in_threadpool(operation, *args, **kwargs)


class _ImmutableStaticFiles(StaticFiles):
    async def get_response(self, path: str, scope):
        response = await super().get_response(path, scope)
        if response.status_code == 200:
            response.headers.setdefault("Cache-Control", "public, max-age=31536000, immutable")
        return response


def _is_allowed_ws_origin(ws: WebSocket) -> bool:
    origin = (ws.headers.get("origin") or "").strip()
    if not origin:
        return True
    if _LOCAL_ORIGIN_RE.match(origin):
        return True
    host = (ws.headers.get("host") or "").strip().lower()
    if host:
        parsed = urlparse(origin)
        if parsed.netloc.lower() == host:
            return True
    return False


app = FastAPI(title="SaturnoLab", version=__version__, lifespan=lifespan)

app.add_middleware(GZipMiddleware, minimum_size=1000)
app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=_LOCAL_ORIGIN_RE.pattern,
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


class KernelCompleteRequest(BaseModel):
    notebook_path: str = ""
    code: str
    cursor_pos: int
    context_code: str = ""


class KernelInspectRequest(BaseModel):
    notebook_path: str = ""
    code: str
    cursor_pos: int
    detail_level: int = 0
    context_code: str = ""


class KernelExpandOutputRequest(BaseModel):
    notebook_path: str
    execution_count: int | None = None
    code: str = ""


@app.get("/api/health")
async def health() -> dict[str, Any]:
    return {
        "status": "ok",
        "version": __version__,
        "workspace": str(config_manager.get_workspace_path()),
    }


@app.get("/api/config")
async def get_config() -> dict[str, Any]:
    return await run_in_threadpool(config_manager.public_dict)


@app.put("/api/config")
async def update_config(patch: dict[str, Any]) -> dict[str, Any]:
    await run_in_threadpool(config_manager.update_settings, patch)
    return await run_in_threadpool(config_manager.public_dict)


def _scan_system_dirs(path: str) -> dict[str, Any]:
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
            try:
                if entry.is_dir():
                    subdirs.append({"name": entry.name, "path": str(entry.resolve())})
            except OSError:
                continue
    except PermissionError:
        pass
    parent = str(base.parent.resolve()) if base.parent != base else None
    return {
        "current": str(base),
        "parent": parent,
        "home": str(Path.home().resolve()),
        "directories": subdirs,
    }


@app.get("/api/system/dirs")
async def browse_system_dirs(path: str = Query(default="")) -> dict[str, Any]:
    return await run_in_threadpool(_scan_system_dirs, path)


@app.post("/api/workspace")
async def switch_workspace(req: WorkspaceSwitchRequest) -> dict[str, Any]:
    try:
        target = Path(req.path).expanduser().resolve()
        if not target.exists() or not target.is_dir():
            raise ValueError(f"Diretório não encontrado: {req.path}")
        await kernel_registry.shutdown_all()
        new_ws = config_manager.set_workspace_path(str(target))
        return {
            "workspace_root": str(new_ws),
            "listing": await run_fs_read(fs_service.list_directory, new_ws, ""),
        }
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.get("/api/fs/list")
async def api_list_dir(
    path: str = Query(default=""), recursive: bool = Query(default=False)
) -> dict[str, Any]:
    try:
        return await run_fs_read(
            fs_service.list_directory,
            config_manager.get_workspace_path(),
            path,
            recursive=recursive,
        )
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except (PermissionError, ValueError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.get("/api/fs/notebook")
async def api_read_notebook(path: str = Query(...)) -> dict[str, Any]:
    try:
        ws = config_manager.get_workspace_path()
        nb = await run_fs_read(fs_service.read_notebook, ws, path)
        existing = kernel_registry.get_existing(ws, nb["path"])
        nb["kernel_status"] = existing.status if existing else "not_started"
        nb["variables"] = existing.variables_cache if existing else []
        if existing and existing.active_cell_id:
            nb["active_cell_id"] = existing.active_cell_id
            nb["active_execution_count"] = existing.active_execution_count
            nb["active_outputs"] = list(existing.active_outputs)
            nb["active_elapsed_ms"] = existing.active_elapsed_ms
            nb["active_started_at"] = existing.active_started_at
        return nb
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/api/fs/notebook/save")
async def api_save_notebook(request: Request) -> dict[str, Any]:
    try:
        ws = config_manager.get_workspace_path()
        raw_body = await request.body()
        # Peek at path quickly when small, or serialize via per-path lock after off-loop JSON decode
        parsed = await run_in_threadpool(json.loads, raw_body)
        if not isinstance(parsed, dict) or not isinstance(parsed.get("path"), str):
            raise ValueError("Payload inválido para salvar notebook.")
        rel_path = parsed["path"]
        cells = parsed.get("cells")
        metadata = parsed.get("metadata")
        if not isinstance(cells, list):
            raise ValueError("Lista de células inválida.")
        if metadata is not None and not isinstance(metadata, dict):
            raise ValueError("Metadados inválidos.")
        lock_key = str(fs_service.safe_resolve(ws, rel_path))
        return await run_fs_file_write(
            lock_key,
            fs_service.save_notebook,
            ws,
            rel_path,
            cells,
            metadata,
        )
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/api/fs/notebook/create")
async def api_create_notebook(req: CreateNotebookRequest) -> dict[str, Any]:
    try:
        return await run_fs_write(
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
        return await run_fs_write(
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
        await run_fs_read(fs_service.plan_rename_entry, ws, req.old_path, req.new_name)
        await kernel_registry.shutdown_notebook(ws, req.old_path, follow_symlinks=False)
        return await run_fs_write(fs_service.rename_entry, ws, req.old_path, req.new_name)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.delete("/api/fs/entry")
async def api_delete(path: str = Query(...)) -> dict[str, Any]:
    try:
        ws = config_manager.get_workspace_path()
        await kernel_registry.shutdown_notebook(ws, path, follow_symlinks=False)
        return await run_fs_write(fs_service.delete_entry, ws, path)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.get("/api/fs/file")
async def api_read_file(path: str = Query(...)) -> dict[str, Any]:
    try:
        return await run_fs_read(fs_service.read_text_file, config_manager.get_workspace_path(), path)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/api/fs/file/save")
async def api_save_file(req: SaveFileRequest) -> dict[str, Any]:
    try:
        ws = config_manager.get_workspace_path()
        lock_key = str(fs_service.safe_resolve(ws, req.path))
        return await run_fs_file_write(
            lock_key,
            fs_service.write_text_file,
            ws,
            req.path,
            req.content,
        )
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/api/fs/file/create")
async def api_create_file(req: CreateFileRequest) -> dict[str, Any]:
    try:
        return await run_fs_write(
            fs_service.create_text_file,
            config_manager.get_workspace_path(),
            req.folder,
            req.name,
        )
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/api/fs/copy")
async def api_copy_entries(req: MoveEntriesRequest) -> dict[str, Any]:
    try:
        return await run_fs_write(
            fs_service.copy_entries,
            config_manager.get_workspace_path(),
            req.paths,
            req.target_folder,
        )
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/api/fs/move")
async def api_move_entries(req: MoveEntriesRequest) -> dict[str, Any]:
    try:
        ws = config_manager.get_workspace_path()
        planned = await run_fs_read(fs_service.plan_move_entries, ws, req.paths, req.target_folder)
        for _, _, path in planned:
            await kernel_registry.shutdown_notebook(ws, path, follow_symlinks=False)
        return await run_fs_write(fs_service.move_entries, ws, req.paths, req.target_folder)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/api/fs/delete-batch")
async def api_delete_batch(req: DeleteBatchRequest) -> dict[str, Any]:
    try:
        ws = config_manager.get_workspace_path()
        for p in req.paths:
            await kernel_registry.shutdown_notebook(ws, p, follow_symlinks=False)
        return await run_fs_write(fs_service.delete_entries, ws, req.paths)
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


@app.post("/api/kernels/complete")
async def api_complete_code(req: KernelCompleteRequest) -> dict[str, Any]:
    ws = config_manager.get_workspace_path()
    session = kernel_registry.get_existing(ws, req.notebook_path) if req.notebook_path else None
    if session:
        res = await session.complete(req.code, req.cursor_pos, run_jedi_fallback=False)
        if res.get("options"):
            return res

    prefix = f"{req.context_code.rstrip()}\n" if req.context_code.strip() else ""
    offset_shift = len(prefix)
    full_code = prefix + req.code
    full_cursor = offset_shift + max(0, min(len(req.code), req.cursor_pos))
    jedi_res = await run_in_threadpool(_jedi_complete_fallback, full_code, full_cursor)
    c_start = max(0, jedi_res["cursor_start"] - offset_shift)
    c_end = max(0, jedi_res["cursor_end"] - offset_shift)
    return _build_completion_payload(
        code=req.code,
        cursor_pos=max(0, min(len(req.code), req.cursor_pos)),
        cursor_start=c_start,
        cursor_end=c_end,
        matches=jedi_res["matches"],
        exp_types=jedi_res["exp_types"],
        variables_cache=session.variables_cache if session else [],
    )


@app.post("/api/kernels/inspect")
async def api_inspect_code(req: KernelInspectRequest) -> dict[str, Any]:
    ws = config_manager.get_workspace_path()
    session = kernel_registry.get_existing(ws, req.notebook_path) if req.notebook_path else None
    if session:
        res = await session.inspect_symbol(
            req.code, req.cursor_pos, req.detail_level, run_jedi_fallback=False
        )
        if res.get("found"):
            return res

    prefix = f"{req.context_code.rstrip()}\n" if req.context_code.strip() else ""
    full_code = prefix + req.code
    full_cursor = len(prefix) + max(0, min(len(req.code), req.cursor_pos))
    return await run_in_threadpool(_jedi_inspect_fallback, full_code, full_cursor)


@app.post("/api/kernels/expand-output")
async def api_expand_output(req: KernelExpandOutputRequest) -> dict[str, Any]:
    ws = config_manager.get_workspace_path()
    session = kernel_registry.get_existing(ws, req.notebook_path)
    if not session:
        return {"found": False}
    return await session.expand_output(req.execution_count, req.code)


@app.websocket("/ws")
async def websocket_endpoint(ws: WebSocket) -> None:
    if not _is_allowed_ws_origin(ws):
        await ws.close(code=1008)
        return
    await ws.accept()
    send_lock = asyncio.Lock()
    ai_tasks: dict[str, asyncio.Task[Any]] = {}
    exec_tasks: set[asyncio.Task[Any]] = set()
    ws_closed = False

    async def safe_send(payload: dict[str, Any]) -> None:
        nonlocal ws_closed
        if ws_closed:
            return
        try:
            async with send_lock:
                await ws.send_json(payload)
        except Exception:
            ws_closed = True

    kernel_registry.add_listener(safe_send)

    # Immediately hydrate active kernel statuses and any in-flight cell execution upon (re)connect.
    initial_sessions = kernel_registry.snapshot_workspace(config_manager.get_workspace_path())
    if initial_sessions:
        await safe_send({"type": "kernel_session_sync", "sessions": initial_sessions})

    async def handle_execute(msg: dict[str, Any]) -> None:
        nb_path = msg.get("notebook_path", "")
        cell_id = msg.get("cell_id", "")
        code = msg.get("code", "")
        batch_id = msg.get("batch_id")
        stop_on_error = bool(msg.get("stop_on_error", False))
        if not nb_path or not cell_id:
            return
        try:
            workspace_root = config_manager.get_workspace_path()
            session = await kernel_registry.get_or_create(workspace_root, nb_path)
            await session.execute_cell(
                cell_id=cell_id,
                code=code,
                on_event=safe_send,
                batch_id=str(batch_id) if batch_id else None,
                stop_on_error=stop_on_error,
            )
        except Exception as exc:
            err_payload = {
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
            done_payload = {
                "type": "cell_execution_done",
                "notebook_path": nb_path,
                "cell_id": cell_id,
                "execution_count": None,
                "variables": [],
                "duration_ms": None,
                "status": "error",
            }
            await safe_send(err_payload)
            await kernel_registry.broadcast(err_payload, exclude=safe_send)
            await safe_send(done_payload)
            await kernel_registry.broadcast(done_payload, exclude=safe_send)

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

            elif action == "sync_kernels":
                sessions = kernel_registry.snapshot_workspace(config_manager.get_workspace_path())
                await safe_send({"type": "kernel_session_sync", "sessions": sessions})

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
        ws_closed = True
        kernel_registry.remove_listener(safe_send)
        for t in list(ai_tasks.values()):
            t.cancel()


# Serve bundled SPA from inside `saturnolab/static`
STATIC_DIR = Path(__file__).resolve().parent / "static"
STATIC_DIR_RESOLVED = STATIC_DIR.resolve()
if (STATIC_DIR / "assets").exists():
    app.mount("/assets", _ImmutableStaticFiles(directory=str(STATIC_DIR / "assets")), name="assets")

_INDEX_HTML_CACHE: tuple[tuple[int, int], str] | None = None


def _read_cached_index_html(index_file: Path) -> str:
    global _INDEX_HTML_CACHE
    st = index_file.stat()
    stamp = (st.st_mtime_ns, st.st_size)
    if _INDEX_HTML_CACHE is not None and _INDEX_HTML_CACHE[0] == stamp:
        return _INDEX_HTML_CACHE[1]
    text = index_file.read_text(encoding="utf-8")
    _INDEX_HTML_CACHE = (stamp, text)
    return text


@app.get("/{full_path:path}", response_model=None)
async def serve_spa(full_path: str):
    if STATIC_DIR.exists():
        candidate = (STATIC_DIR / full_path).resolve()
        if (
            full_path
            and candidate.name != "index.html"
            and candidate.is_file()
            and STATIC_DIR_RESOLVED in candidate.parents
        ):
            return FileResponse(str(candidate))
        index_file = STATIC_DIR / "index.html"
        if index_file.is_file():
            # Supply only UI settings, so the first render has the final geometry.
            cfg = config_manager.config
            fields = (
                "theme",
                "active_provider",
                "default_ai_apply_mode",
                "include_kernel_variables",
                "notebook_layout",
                "sidebar_position",
                "sidebar_width",
                "editor_font_size",
                "show_line_numbers",
                "auto_scroll_on_run",
                "show_modified_time",
                "confirm_kernel_restart",
                "auto_save",
                "auto_save_delay",
                "output_display",
                "output_format",
                "output_height",
                "show_minimap",
                "minimap_width",
                "minimap_show_outputs",
            )
            bootstrap = {field: getattr(cfg, field) for field in fields}
            bootstrap.update(
                workspace_dir=str(config_manager.get_workspace_path()),
                providers={},
                table_output=cfg.table_output.model_dump(),
            )
            payload = json.dumps(bootstrap).replace("<", "\\u003c")
            html = await run_in_threadpool(_read_cached_index_html, index_file)
            html = html.replace(
                "</head>", f"<script>window.__SATURNO_BOOTSTRAP__={payload};</script></head>"
            )
            return HTMLResponse(html, headers={"Cache-Control": "no-store"})
    return HTMLResponse(
        "<h3>SaturnoLab frontend static assets not built yet. Run <code>npm run build</code> in <code>frontend/</code>.</h3>",
        status_code=503,
    )
