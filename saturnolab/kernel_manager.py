from __future__ import annotations

import ast
import asyncio
import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Any, Awaitable, Callable

from jupyter_client.manager import AsyncKernelManager

KERNEL_INIT_TEMPLATE = r"""
{extra_site_setup}
try:
    get_ipython().run_line_magic('matplotlib', 'inline')
except Exception:
    pass

def __saturno_inspect_ns__():
    import json as _json
    import types as _types
    _ip = get_ipython()
    _ns = _ip.user_ns if _ip else globals()
    _skip = {{'In', 'Out', 'get_ipython', 'exit', 'quit', 'open'}}
    _items = []
    for _k, _v in list(_ns.items()):
        if _k.startswith('_') or _k in _skip:
            continue
        if isinstance(_v, (_types.ModuleType, _types.FunctionType, _types.BuiltinFunctionType, type)):
            continue
        _tname = type(_v).__name__
        _shape = ""
        _preview = ""
        try:
            if _tname == "DataFrame" and hasattr(_v, "columns") and hasattr(_v, "dtypes"):
                _shape = str(tuple(_v.shape))
                _cols = [f"{{c}} ({{_v.dtypes[c]}})" for c in list(_v.columns)[:25]]
                _preview = "cols: [" + ", ".join(_cols) + (
                    f", ...+{{len(_v.columns)-25}}" if len(_v.columns) > 25 else ""
                ) + "]"
            elif _tname == "Series" and hasattr(_v, "dtype"):
                _shape = str(tuple(_v.shape))
                _preview = f"dtype={{_v.dtype}}, name={{getattr(_v, 'name', None)}}"
            elif hasattr(_v, "shape") and hasattr(_v, "dtype"):
                _shape = str(getattr(_v, "shape", ""))
                _preview = f"dtype={{getattr(_v, 'dtype', '')}}"
            elif isinstance(_v, (list, tuple, set, dict)):
                _shape = f"len={{len(_v)}}"
                _r = repr(_v)
                _preview = _r[:90] + ("..." if len(_r) > 90 else "")
            else:
                _r = repr(_v)
                _preview = _r[:90] + ("..." if len(_r) > 90 else "")
        except Exception:
            _preview = "<unavailable>"
        _items.append({{
            "name": _k,
            "type": _tname,
            "shape": _shape,
            "preview": _preview,
        }})
        if len(_items) >= 50:
            break
    return _json.dumps(_items, ensure_ascii=False)
"""

EventCallback = Callable[[dict[str, Any]], Awaitable[None]]


def _python_bin_in_env(env_dir: Path) -> Path:
    if os.name == "nt":
        return env_dir / "Scripts" / "python.exe"
    return env_dir / "bin" / "python"


_ENV_CACHE: dict[str, tuple[str, str]] = {}


def _resolve_kernel_environment(workspace_dir: Path) -> tuple[str, str]:
    """Return (python_executable, extra_site_packages_dir_or_empty)."""
    cache_key = str(workspace_dir.resolve())
    if cache_key in _ENV_CACHE:
        return _ENV_CACHE[cache_key]

    candidates: list[Path] = []

    # 1. Workspace-local virtual environments take top priority
    for folder_name in (".venv", "venv", ".env"):
        p = _python_bin_in_env(workspace_dir / folder_name)
        if p.exists():
            candidates.append(p)

    # 2. Active shell VIRTUAL_ENV or CONDA_PREFIX (if not SaturnoLab's own uv tool env)
    for env_var in ("VIRTUAL_ENV", "CONDA_PREFIX"):
        val = os.environ.get(env_var, "").strip()
        if val:
            env_path = Path(val).resolve()
            if "uv/tools/saturnolab" not in str(env_path).replace("\\", "/"):
                p = _python_bin_in_env(env_path)
                if p.exists() and p not in candidates:
                    candidates.append(p)

    fallback_site_dir = ""

    for cand in candidates:
        try:
            probe = subprocess.run(
                [
                    str(cand),
                    "-c",
                    (
                        "import importlib.util, json, sys, sysconfig; "
                        "print(json.dumps({"
                        "'has_ipykernel': importlib.util.find_spec('ipykernel') is not None, "
                        "'ver': list(sys.version_info[:2]), "
                        "'purelib': sysconfig.get_paths().get('purelib', '')"
                        "}))"
                    ),
                ],
                capture_output=True,
                text=True,
                timeout=3,
            )
            if probe.returncode == 0:
                info = json.loads(probe.stdout.strip())
                if info.get("has_ipykernel"):
                    res = (str(cand), "")
                    _ENV_CACHE[cache_key] = res
                    return res
                if (
                    not fallback_site_dir
                    and info.get("ver") == list(sys.version_info[:2])
                    and info.get("purelib")
                ):
                    fallback_site_dir = info["purelib"]
        except Exception:
            continue

    res = (sys.executable, fallback_site_dir)
    _ENV_CACHE[cache_key] = res
    return res


class NotebookKernelSession:
    def __init__(
        self,
        notebook_path: str,
        cwd: Path,
        python_exe: str,
        extra_site_dir: str = "",
    ) -> None:
        self.notebook_path = notebook_path
        self.cwd = cwd
        self.python_exe = python_exe
        self.extra_site_dir = extra_site_dir
        self.km = AsyncKernelManager(
            kernel_cmd=[python_exe, "-m", "ipykernel_launcher", "-f", "{connection_file}"]
        )
        self.kc: Any = None
        self.status: str = "starting"
        self.execution_lock = asyncio.Lock()
        self.variables_cache: list[dict[str, Any]] = []

    async def start(self) -> None:
        self.cwd.mkdir(parents=True, exist_ok=True)
        await self.km.start_kernel(cwd=str(self.cwd))
        self.kc = self.km.client()
        self.kc.start_channels()
        await self.kc.wait_for_ready(timeout=20)
        await self._run_silent_init()
        self.status = "idle"

    async def _run_silent_init(self) -> None:
        if not self.kc:
            return
        extra_setup = ""
        if self.extra_site_dir:
            extra_setup = f"import site as _site; _site.addsitedir({self.extra_site_dir!r})"
        init_code = KERNEL_INIT_TEMPLATE.format(extra_site_setup=extra_setup)
        msg_id = self.kc.execute(init_code, silent=True, store_history=False)
        try:
            while True:
                msg = await self.kc.get_iopub_msg(timeout=8)
                if msg.get("parent_header", {}).get("msg_id") == msg_id:
                    if (
                        msg.get("msg_type") == "status"
                        and msg.get("content", {}).get("execution_state") == "idle"
                    ):
                        break
        except Exception:
            pass

    async def execute_cell(
        self,
        cell_id: str,
        code: str,
        on_event: EventCallback,
    ) -> dict[str, Any]:
        async with self.execution_lock:
            if not self.kc or not await self.km.is_alive():
                await self.start()

            self.status = "busy"
            await on_event(
                {
                    "type": "kernel_status",
                    "notebook_path": self.notebook_path,
                    "status": "busy",
                }
            )
            await on_event(
                {
                    "type": "cell_execution_start",
                    "notebook_path": self.notebook_path,
                    "cell_id": cell_id,
                }
            )

            msg_id = self.kc.execute(
                code,
                silent=False,
                store_history=True,
                allow_stdin=False,
                user_expressions={"__vars__": "__saturno_inspect_ns__()"},
            )

            execution_count: int | None = None
            outputs: list[dict[str, Any]] = []

            try:
                while True:
                    msg = await self.kc.get_iopub_msg(timeout=300)
                    if msg.get("parent_header", {}).get("msg_id") != msg_id:
                        continue

                    mtype = msg.get("msg_type", "")
                    content = msg.get("content", {})

                    if mtype == "execute_input":
                        execution_count = content.get("execution_count")
                        await on_event(
                            {
                                "type": "cell_execution_count",
                                "notebook_path": self.notebook_path,
                                "cell_id": cell_id,
                                "execution_count": execution_count,
                            }
                        )
                    elif mtype == "clear_output":
                        outputs.clear()
                        await on_event(
                            {
                                "type": "cell_clear_output",
                                "notebook_path": self.notebook_path,
                                "cell_id": cell_id,
                            }
                        )
                    elif mtype == "stream":
                        out_item = {
                            "output_type": "stream",
                            "name": content.get("name", "stdout"),
                            "text": content.get("text", ""),
                        }
                        outputs.append(out_item)
                        await on_event(
                            {
                                "type": "cell_output",
                                "notebook_path": self.notebook_path,
                                "cell_id": cell_id,
                                "output": out_item,
                            }
                        )
                    elif mtype in ("display_data", "execute_result"):
                        if mtype == "execute_result" and content.get("execution_count") is not None:
                            execution_count = content.get("execution_count")
                        out_item = {
                            "output_type": mtype,
                            "data": content.get("data", {}),
                            "execution_count": content.get("execution_count"),
                        }
                        outputs.append(out_item)
                        await on_event(
                            {
                                "type": "cell_output",
                                "notebook_path": self.notebook_path,
                                "cell_id": cell_id,
                                "output": out_item,
                            }
                        )
                    elif mtype == "error":
                        out_item = {
                            "output_type": "error",
                            "ename": content.get("ename", "Error"),
                            "evalue": content.get("evalue", ""),
                            "traceback": content.get("traceback", []),
                        }
                        outputs.append(out_item)
                        await on_event(
                            {
                                "type": "cell_output",
                                "notebook_path": self.notebook_path,
                                "cell_id": cell_id,
                                "output": out_item,
                            }
                        )
                    elif mtype == "status" and content.get("execution_state") == "idle":
                        break

                try:
                    while True:
                        reply = await self.kc.get_shell_msg(timeout=2)
                        if reply.get("parent_header", {}).get("msg_id") == msg_id:
                            rcontent = reply.get("content", {})
                            if execution_count is None and rcontent.get("execution_count") is not None:
                                execution_count = rcontent.get("execution_count")
                            uexpr = rcontent.get("user_expressions", {}).get("__vars__", {})
                            if uexpr.get("status") == "ok":
                                raw_json_repr = uexpr.get("data", {}).get("text/plain", "")
                                if raw_json_repr:
                                    parsed_str = ast.literal_eval(raw_json_repr)
                                    self.variables_cache = json.loads(parsed_str)
                            break
                except Exception:
                    pass

            finally:
                self.status = "idle"
                await on_event(
                    {
                        "type": "cell_execution_done",
                        "notebook_path": self.notebook_path,
                        "cell_id": cell_id,
                        "execution_count": execution_count,
                        "variables": self.variables_cache,
                    }
                )
                await on_event(
                    {
                        "type": "kernel_status",
                        "notebook_path": self.notebook_path,
                        "status": "idle",
                    }
                )

            return {
                "execution_count": execution_count,
                "outputs": outputs,
                "variables": self.variables_cache,
            }

    async def interrupt(self) -> None:
        if await self.km.is_alive():
            await self.km.interrupt_kernel()

    async def restart(self) -> None:
        if await self.km.is_alive():
            await self.km.restart_kernel(now=True)
            if self.kc:
                await self.kc.wait_for_ready(timeout=20)
            await self._run_silent_init()
        else:
            await self.start()
        self.variables_cache = []
        self.status = "idle"

    async def shutdown(self) -> None:
        try:
            if self.kc:
                self.kc.stop_channels()
            if await self.km.is_alive():
                await self.km.shutdown_kernel(now=True)
        except Exception:
            pass
        self.status = "stopped"


class SaturnoKernelRegistry:
    def __init__(self) -> None:
        self._sessions: dict[str, NotebookKernelSession] = {}
        self._locks: dict[str, asyncio.Lock] = {}

    async def get_or_create(
        self, workspace_root: Path, notebook_rel_path: str
    ) -> NotebookKernelSession:
        key = str((workspace_root / notebook_rel_path).resolve())
        lock = self._locks.setdefault(key, asyncio.Lock())
        async with lock:
            session = self._sessions.get(key)
            if session and await session.km.is_alive():
                return session
            nb_full = (workspace_root / notebook_rel_path).resolve()
            nb_cwd = nb_full.parent if nb_full.parent.exists() else workspace_root.resolve()
            py_exe, extra_site = await asyncio.to_thread(
                _resolve_kernel_environment, workspace_root.resolve()
            )
            session = NotebookKernelSession(
                notebook_path=notebook_rel_path,
                cwd=nb_cwd,
                python_exe=py_exe,
                extra_site_dir=extra_site,
            )
            await session.start()
            self._sessions[key] = session
            return session

    def get_existing(
        self, workspace_root: Path, notebook_rel_path: str
    ) -> NotebookKernelSession | None:
        key = str((workspace_root / notebook_rel_path).resolve())
        return self._sessions.get(key)

    def list_active(self) -> list[dict[str, Any]]:
        return [
            {
                "notebook_path": s.notebook_path,
                "status": s.status,
                "python_executable": s.python_exe,
                "variables_count": len(s.variables_cache),
            }
            for s in self._sessions.values()
        ]

    async def shutdown_notebook(self, workspace_root: Path, notebook_rel_path: str) -> None:
        key = str((workspace_root / notebook_rel_path).resolve())
        session = self._sessions.pop(key, None)
        if session:
            await session.shutdown()

    async def shutdown_all(self) -> None:
        for s in list(self._sessions.values()):
            await s.shutdown()
        self._sessions.clear()


kernel_registry = SaturnoKernelRegistry()
