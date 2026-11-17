from __future__ import annotations

import ast
import asyncio
import json
import os
import queue
import re
import subprocess
import sys
from pathlib import Path
from typing import Any, Awaitable, Callable

from jupyter_client.manager import AsyncKernelManager

_ANSI_ESCAPE_RE = re.compile(r"\x1B\[[0-?]*[ -/]*[@-~]")

KERNEL_INIT_TEMPLATE = r"""
{extra_site_setup}
import os as _sat_os
_sat_os.environ.setdefault("PLOTLY_RENDERER", "plotly_mimetype")
try:
    get_ipython().run_line_magic('matplotlib', 'inline')
except Exception:
    pass

def __saturno_configure_display_libs__():
    import sys as _sys
    _pio = _sys.modules.get("plotly.io")
    if _pio is not None and hasattr(_pio, "renderers"):
        try:
            if getattr(_pio.renderers, "default", "") in ("", "browser", "plotly_mimetype+notebook"):
                _pio.renderers.default = "plotly_mimetype"
        except Exception:
            pass

def __saturno_expand_output__(_exec_count=None, _expr_code=""):
    import json as _json
    import sys as _sys
    import ast as _ast
    _ip = get_ipython()
    _ns = _ip.user_ns if _ip else globals()
    _obj = None
    _found = False
    if _exec_count is not None:
        _out_dict = _ns.get("Out", {{}})
        if _exec_count in _out_dict:
            _obj = _out_dict[_exec_count]
            _found = True
        elif str(_exec_count).isdigit() and int(_exec_count) in _out_dict:
            _obj = _out_dict[int(_exec_count)]
            _found = True
    if not _found and _expr_code and _expr_code.strip():
        try:
            _tree = _ast.parse(_expr_code)
            if _tree.body and isinstance(_tree.body[-1], _ast.Expr):
                _last_expr = _ast.Expression(_tree.body[-1].value)
                _obj = eval(compile(_last_expr, "<saturno-expand>", "eval"), _ns)
                _found = True
        except Exception:
            pass
    if not _found and "_" in _ns and _ns["_"] is not None:
        _obj = _ns["_"]
        _found = True
    if not _found or _obj is None:
        return _json.dumps({{"found": False}}, ensure_ascii=False)
    _pd = _sys.modules.get("pandas")
    _pl = _sys.modules.get("polars")
    _html = None
    _text = None
    try:
        if _pd is not None and hasattr(_pd, "option_context"):
            with _pd.option_context(
                "display.max_colwidth", None,
                "display.max_columns", None,
                "display.max_rows", 500,
                "display.width", None,
                "display.max_seq_items", None,
            ):
                if hasattr(_obj, "_repr_html_"):
                    _html = _obj._repr_html_()
                _text = repr(_obj)
        elif _pl is not None and hasattr(_pl, "Config"):
            with _pl.Config(
                fmt_str_lengths=10000,
                tbl_cols=-1,
                tbl_rows=500,
                tbl_width_chars=10000,
            ):
                if hasattr(_obj, "_repr_html_"):
                    _html = _obj._repr_html_()
                _text = repr(_obj)
        else:
            if hasattr(_obj, "_repr_html_"):
                _html = _obj._repr_html_()
            _text = repr(_obj)
    except Exception:
        _text = repr(_obj)
    return _json.dumps({{
        "found": True,
        "text/html": _html,
        "text/plain": _text,
    }}, ensure_ascii=False)

def __saturno_inspect_ns__():
    __saturno_configure_display_libs__()
    import json as _json
    import reprlib as _reprlib
    import types as _types
    _rlib = _reprlib.Repr()
    _rlib.maxlist = 6
    _rlib.maxtuple = 6
    _rlib.maxset = 6
    _rlib.maxdict = 5
    _rlib.maxstring = 80
    _rlib.maxother = 80
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
        _columns = None
        try:
            if _tname == "DataFrame" and hasattr(_v, "columns") and hasattr(_v, "dtypes"):
                if hasattr(_v, "shape"):
                    _shape = str(tuple(_v.shape))
                _col_names = list(_v.columns)
                _dtypes_raw = _v.dtypes
                if isinstance(_dtypes_raw, (list, tuple)):
                    _all_pairs = list(zip(_col_names[:150], _dtypes_raw[:150]))
                else:
                    _all_pairs = list(zip(_col_names[:150], list(_dtypes_raw)[:150]))
                _pairs = _all_pairs[:25]
                _cols = [f"{{c}} ({{dt}})" for c, dt in _pairs]
                _preview = "cols: [" + ", ".join(_cols) + (
                    f", ...+{{len(_col_names)-25}}" if len(_col_names) > 25 else ""
                ) + "]"
                _columns = [{{"name": str(c), "dtype": str(dt)}} for c, dt in _all_pairs]
            elif _tname == "LazyFrame" and hasattr(_v, "collect_schema"):
                _schema = _v.collect_schema()
                _col_names = list(_schema.names())
                _shape = f"cols={{len(_col_names)}}"
                _cols = [f"{{c}} ({{_schema[c]}})" for c in _col_names[:25]]
                _preview = "cols: [" + ", ".join(_cols) + (
                    f", ...+{{len(_col_names)-25}}" if len(_col_names) > 25 else ""
                ) + "]"
                _columns = [{{"name": str(c), "dtype": str(_schema[c])}} for c in _col_names[:150]]
            elif _tname == "Series" and hasattr(_v, "dtype"):
                if hasattr(_v, "shape"):
                    _shape = str(tuple(_v.shape))
                elif hasattr(_v, "__len__"):
                    _shape = f"({{len(_v)}},)"
                _preview = f"dtype={{_v.dtype}}, name={{getattr(_v, 'name', None)}}"
            elif hasattr(_v, "shape") and hasattr(_v, "dtype"):
                _shape = str(getattr(_v, "shape", ""))
                _preview = f"dtype={{getattr(_v, 'dtype', '')}}"
            elif isinstance(_v, (str, bytes, bytearray)):
                _shape = f"len={{len(_v)}}"
                _r = _rlib.repr(_v)
                _preview = _r[:90] + ("..." if len(_r) > 90 else "")
            elif isinstance(_v, (list, tuple, set, dict)):
                _shape = f"len={{len(_v)}}"
                _r = _rlib.repr(_v)
                _preview = _r[:90] + ("..." if len(_r) > 90 else "")
            else:
                _r = _rlib.repr(_v)
                _preview = _r[:90] + ("..." if len(_r) > 90 else "")
        except Exception:
            _preview = "<unavailable>"
        _entry = {{
            "name": _k,
            "type": _tname,
            "shape": _shape,
            "preview": _preview,
        }}
        if _columns is not None:
            _entry["columns"] = _columns
        _items.append(_entry)
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
        self._abort_epoch: int = 0
        self._failed_batches: set[str] = set()

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

    def _mark_batch_failed(self, batch_id: str | None) -> None:
        if not batch_id:
            return
        if len(self._failed_batches) >= 64:
            self._failed_batches.clear()
        self._failed_batches.add(batch_id)

    async def execute_cell(
        self,
        cell_id: str,
        code: str,
        on_event: EventCallback,
        *,
        batch_id: str | None = None,
        stop_on_error: bool = False,
    ) -> dict[str, Any]:
        queued_epoch = self._abort_epoch
        async with self.execution_lock:
            if queued_epoch != self._abort_epoch or (batch_id and batch_id in self._failed_batches):
                await on_event(
                    {
                        "type": "cell_execution_done",
                        "notebook_path": self.notebook_path,
                        "cell_id": cell_id,
                        "execution_count": None,
                        "variables": self.variables_cache,
                    }
                )
                return {
                    "execution_count": None,
                    "outputs": [],
                    "variables": self.variables_cache,
                }

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
            had_error = False

            try:
                while True:
                    try:
                        msg = await self.kc.get_iopub_msg(timeout=2.0)
                    except (asyncio.TimeoutError, TimeoutError, queue.Empty):
                        if not await self.km.is_alive():
                            had_error = True
                            out_item = {
                                "output_type": "error",
                                "ename": "KernelDied",
                                "evalue": "O processo do kernel foi encerrado inesperadamente (possível falta de memória ou falha nativa).",
                                "traceback": [
                                    "KernelDied: O processo do kernel foi encerrado inesperadamente."
                                ],
                            }
                            outputs.append(out_item)
                            self.variables_cache = []
                            await on_event(
                                {
                                    "type": "cell_output",
                                    "notebook_path": self.notebook_path,
                                    "cell_id": cell_id,
                                    "output": out_item,
                                }
                            )
                            break
                        continue

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
                        had_error = True
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
                            if rcontent.get("status") == "error":
                                had_error = True
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

                if had_error and stop_on_error:
                    self._mark_batch_failed(batch_id)

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
        self._abort_epoch += 1
        if await self.km.is_alive():
            await self.km.interrupt_kernel()

    async def restart(self) -> None:
        self._abort_epoch += 1
        self._failed_batches.clear()
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
        self._abort_epoch += 1
        try:
            if self.kc:
                self.kc.stop_channels()
            if await self.km.is_alive():
                await self.km.shutdown_kernel(now=True)
        except Exception:
            pass
        self.status = "stopped"

    async def complete(self, code: str, cursor_pos: int) -> dict[str, Any]:
        cursor_pos = max(0, min(len(code), int(cursor_pos)))
        matches: list[str] = []
        cursor_start: int = cursor_pos
        cursor_end: int = cursor_pos
        exp_types: list[dict[str, Any]] = []

        if self.kc and not self.execution_lock.locked() and await self.km.is_alive():
            try:
                async with self.execution_lock:
                    msg_id = self.kc.complete(code, cursor_pos)
                    deadline = asyncio.get_running_loop().time() + 1.5
                    while True:
                        remaining = deadline - asyncio.get_running_loop().time()
                        if remaining <= 0:
                            break
                        reply = await self.kc.get_shell_msg(timeout=remaining)
                        if reply.get("parent_header", {}).get("msg_id") == msg_id:
                            rcontent = reply.get("content", {})
                            if rcontent.get("status") == "ok":
                                matches = list(rcontent.get("matches") or [])
                                cursor_start = int(rcontent.get("cursor_start", cursor_pos))
                                cursor_end = int(rcontent.get("cursor_end", cursor_pos))
                                meta = rcontent.get("metadata") or {}
                                exp_types = list(meta.get("_jupyter_types_experimental") or [])
                            break
            except Exception:
                pass

        if not matches:
            jedi_res = await asyncio.to_thread(_jedi_complete_fallback, code, cursor_pos)
            matches = jedi_res["matches"]
            cursor_start = jedi_res["cursor_start"]
            cursor_end = jedi_res["cursor_end"]
            exp_types = jedi_res["exp_types"]

        return _build_completion_payload(
            code=code,
            cursor_pos=cursor_pos,
            cursor_start=cursor_start,
            cursor_end=cursor_end,
            matches=matches,
            exp_types=exp_types,
            variables_cache=self.variables_cache,
        )

    async def inspect_symbol(
        self, code: str, cursor_pos: int, detail_level: int = 0
    ) -> dict[str, Any]:
        cursor_pos = max(0, min(len(code), int(cursor_pos)))
        candidate_positions: list[int] = [cursor_pos]
        if cursor_pos > 0 and (
            cursor_pos == len(code) or not (code[cursor_pos].isalnum() or code[cursor_pos] == "_")
        ):
            if code[cursor_pos - 1].isalnum() or code[cursor_pos - 1] == "_":
                candidate_positions.insert(0, cursor_pos)
        enclosing_pos = _find_enclosing_callable_pos(code, cursor_pos)
        if enclosing_pos is not None and enclosing_pos not in candidate_positions:
            candidate_positions.append(enclosing_pos)

        if self.kc and not self.execution_lock.locked() and await self.km.is_alive():
            try:
                async with self.execution_lock:
                    for pos in candidate_positions:
                        msg_id = self.kc.inspect(code, pos, detail_level=detail_level)
                        deadline = asyncio.get_running_loop().time() + 1.8
                        while True:
                            remaining = deadline - asyncio.get_running_loop().time()
                            if remaining <= 0:
                                break
                            reply = await self.kc.get_shell_msg(timeout=remaining)
                            if reply.get("parent_header", {}).get("msg_id") == msg_id:
                                rcontent = reply.get("content", {})
                                if rcontent.get("status") == "ok" and rcontent.get("found"):
                                    raw_plain = (rcontent.get("data") or {}).get("text/plain", "")
                                    if raw_plain:
                                        sym_name = _extract_symbol_near(code, pos)
                                        return _parse_ipython_inspect(raw_plain, sym_name)
                                break
            except Exception:
                pass

        return await asyncio.to_thread(_jedi_inspect_fallback, code, cursor_pos)

    async def expand_output(
        self, execution_count: int | None = None, code: str = ""
    ) -> dict[str, Any]:
        if not self.kc or not await self.km.is_alive():
            return {"found": False}
        if self.execution_lock.locked():
            return {"found": False, "busy": True}

        async with self.execution_lock:
            expr = f"__saturno_expand_output__({execution_count!r}, {code!r})"
            msg_id = self.kc.execute(
                "",
                silent=True,
                store_history=False,
                allow_stdin=False,
                user_expressions={"__expanded__": expr},
            )
            try:
                deadline = asyncio.get_running_loop().time() + 4.0
                while True:
                    remaining = deadline - asyncio.get_running_loop().time()
                    if remaining <= 0:
                        break
                    reply = await self.kc.get_shell_msg(timeout=remaining)
                    if reply.get("parent_header", {}).get("msg_id") == msg_id:
                        rcontent = reply.get("content", {})
                        uexpr = (rcontent.get("user_expressions") or {}).get("__expanded__", {})
                        if uexpr.get("status") == "ok":
                            raw_repr = (uexpr.get("data") or {}).get("text/plain", "")
                            if raw_repr:
                                parsed_str = ast.literal_eval(raw_repr)
                                return json.loads(parsed_str)
                        break
            except Exception:
                pass
        return {"found": False}


def _strip_ansi(text: str) -> str:
    return _ANSI_ESCAPE_RE.sub("", text or "")


def _offset_to_line_col(code: str, offset: int) -> tuple[int, int]:
    clamped = max(0, min(len(code), offset))
    prefix = code[:clamped]
    lines = prefix.split("\n")
    return len(lines), len(lines[-1])


def _extract_symbol_near(code: str, pos: int) -> str:
    clamped = max(0, min(len(code), pos))
    left = clamped
    while left > 0 and (code[left - 1].isalnum() or code[left - 1] in ("_", ".")):
        left -= 1
    right = clamped
    while right < len(code) and (code[right].isalnum() or code[right] == "_"):
        right += 1
    return code[left:right].strip(".")


def _find_enclosing_callable_pos(code: str, cursor_pos: int) -> int | None:
    """Walk backwards from cursor_pos to find the identifier before an unmatched '('."""
    i = max(0, min(len(code), cursor_pos)) - 1
    depth_paren = 0
    depth_bracket = 0
    depth_brace = 0
    in_quote: str | None = None

    while i >= 0:
        ch = code[i]
        if in_quote:
            if ch == in_quote and (i == 0 or code[i - 1] != "\\"):
                in_quote = None
            i -= 1
            continue
        if ch in ("'", '"'):
            in_quote = ch
            i -= 1
            continue
        if ch == ")":
            depth_paren += 1
        elif ch == "(":
            if depth_paren > 0:
                depth_paren -= 1
            else:
                j = i - 1
                while j >= 0 and code[j] in (" ", "\t"):
                    j -= 1
                if j >= 0 and (code[j].isalnum() or code[j] == "_"):
                    return j + 1
                return None
        elif ch == "]":
            depth_bracket += 1
        elif ch == "[":
            if depth_bracket > 0:
                depth_bracket -= 1
        elif ch == "}":
            depth_brace += 1
        elif ch == "{":
            if depth_brace > 0:
                depth_brace -= 1
        i -= 1
    return None


def _map_completion_type(raw_type: str) -> str:
    t = (raw_type or "").lower().strip()
    if t in ("function", "method"):
        return t
    if t in ("instance", "statement", "variable"):
        return "variable"
    if t in ("dict key", "column"):
        return "property"
    if t in ("property", "param"):
        return "property"
    if t in ("class", "type"):
        return "class"
    if t in ("module", "namespace"):
        return "module"
    if t == "keyword":
        return "keyword"
    return "variable"


def _build_completion_payload(
    code: str,
    cursor_pos: int,
    cursor_start: int,
    cursor_end: int,
    matches: list[str],
    exp_types: list[dict[str, Any]],
    variables_cache: list[dict[str, Any]],
) -> dict[str, Any]:
    prefix_before_cursor = code[:cursor_pos]
    var_map = {v.get("name", ""): v for v in variables_cache if v.get("name")}

    # Detect if completing on a known DataFrame/LazyFrame variable:
    # 1) df.<attr>
    # 2) df["<col> or df['<col> or df[<col>
    # 3) df.groupby("<col> or df[["<col>
    dot_match = re.search(r"\b([A-Za-z_]\w*)\.([A-Za-z0-9_]*)$", prefix_before_cursor)
    bracket_match = re.search(
        r"\b([A-Za-z_]\w*)\[\s*(?:\[\s*)?(['\"]?)([^'\"\]]*)$", prefix_before_cursor
    )
    call_str_match = re.search(
        r"\b([A-Za-z_]\w*)\.[A-Za-z_]\w*\([^)]*(['\"])([^'\"]*)$", prefix_before_cursor
    )

    target_df_var: dict[str, Any] | None = None
    in_string_col_mode = False
    need_quotes_for_col = False

    if dot_match and dot_match.group(1) in var_map:
        target_df_var = var_map[dot_match.group(1)]
    elif bracket_match and bracket_match.group(1) in var_map:
        target_df_var = var_map[bracket_match.group(1)]
        in_string_col_mode = True
        quote_char = bracket_match.group(2)
        need_quotes_for_col = quote_char == ""
        cursor_start = cursor_pos - len(bracket_match.group(3))
    elif call_str_match and call_str_match.group(1) in var_map:
        target_df_var = var_map[call_str_match.group(1)]
        in_string_col_mode = True
        cursor_start = cursor_pos - len(call_str_match.group(3))

    df_cols_map: dict[str, str] = {}
    if target_df_var:
        for col_entry in target_df_var.get("columns") or []:
            cname = str(col_entry.get("name", ""))
            cdtype = str(col_entry.get("dtype", ""))
            if cname:
                df_cols_map[cname] = cdtype
        if not df_cols_map:
            prev = str(target_df_var.get("preview", ""))
            if prev.startswith("cols: ["):
                inner = prev[7:].rstrip("]")
                for part in inner.split(", "):
                    if part.startswith("...+"):
                        continue
                    m = re.match(r"^(.+?)\s*\(([^()]+)\)$", part)
                    if m:
                        df_cols_map[m.group(1)] = m.group(2)

    type_meta_by_text: dict[str, dict[str, Any]] = {}
    for item in exp_types:
        txt = str(item.get("text", ""))
        if txt:
            type_meta_by_text[txt] = item

    typed_fragment = code[cursor_start:cursor_pos]
    allow_private = typed_fragment.startswith("_")

    seen: set[str] = set()
    options: list[dict[str, Any]] = []

    # Prepend DataFrame columns when inside df[...], df["..."], df.groupby("..."), or df.<col>
    if df_cols_map:
        frag_lower = typed_fragment.lower().strip("'\"")
        for col_name, col_dtype in df_cols_map.items():
            if not in_string_col_mode and not col_name.isidentifier():
                continue
            if frag_lower and not col_name.lower().startswith(frag_lower):
                continue
            label = f'"{col_name}"' if (in_string_col_mode and need_quotes_for_col) else col_name
            if label in seen:
                continue
            seen.add(label)
            options.append(
                {
                    "label": label,
                    "type": "property",
                    "detail": f"coluna · {col_dtype}" if col_dtype else "coluna",
                    "boost": 30,
                }
            )

    for m in matches:
        label = str(m)
        if not label or label in seen:
            continue
        # Skip path completions or magics when inside DataFrame column string context
        if in_string_col_mode and (df_cols_map or label.startswith("%")):
            if "/" in label or "\\" in label or label.startswith("%"):
                continue
        if label.startswith("%") and not typed_fragment.startswith("%"):
            continue
        clean_unquoted = label.strip("'\"")
        if not allow_private and label.startswith("_"):
            continue
        seen.add(label)

        meta_item = type_meta_by_text.get(label, {})
        raw_t = str(meta_item.get("type", ""))
        sig = str(meta_item.get("signature", ""))

        if clean_unquoted in df_cols_map:
            col_dt = df_cols_map[clean_unquoted]
            options.append(
                {
                    "label": label,
                    "type": "property",
                    "detail": f"coluna · {col_dt}" if col_dt else "coluna",
                    "boost": 28,
                }
            )
            continue

        if not dot_match and not in_string_col_mode and label in var_map:
            vinfo = var_map[label]
            vtype = str(vinfo.get("type", ""))
            vshape = str(vinfo.get("shape", ""))
            options.append(
                {
                    "label": label,
                    "type": "variable",
                    "detail": f"{vtype} {vshape}".strip(),
                    "boost": 20,
                }
            )
            continue

        mapped_type = _map_completion_type(raw_t)
        if dot_match and mapped_type == "function":
            mapped_type = "method"
        detail = sig if sig else ( "chave" if raw_t == "dict key" else (raw_t if raw_t and raw_t != "<unknown>" else ""))
        boost = 15 if raw_t == "dict key" else (10 if mapped_type in ("method", "function", "property") else 5)
        if label.startswith("__"):
            boost = -15
        elif label.startswith("_"):
            boost = -5

        options.append(
            {
                "label": label,
                "type": mapped_type,
                "detail": detail,
                "boost": boost,
            }
        )

    # Also include live kernel variables if completing a top-level identifier
    if not dot_match and not in_string_col_mode:
        frag_lower = typed_fragment.lower()
        for vname, vinfo in var_map.items():
            if vname in seen:
                continue
            if frag_lower and not vname.lower().startswith(frag_lower):
                continue
            seen.add(vname)
            vtype = str(vinfo.get("type", ""))
            vshape = str(vinfo.get("shape", ""))
            options.append(
                {
                    "label": vname,
                    "type": "variable",
                    "detail": f"{vtype} {vshape}".strip(),
                    "boost": 20,
                }
            )

    return {
        "from": cursor_start,
        "to": cursor_end,
        "options": options[:250],
    }


def _jedi_complete_fallback(code: str, cursor_pos: int) -> dict[str, Any]:
    cursor_pos = max(0, min(len(code), int(cursor_pos)))
    m = re.search(r"[A-Za-z_]\w*$", code[:cursor_pos])
    cursor_start = m.start() if m else cursor_pos
    matches: list[str] = []
    exp_types: list[dict[str, Any]] = []
    try:
        import jedi

        line, col = _offset_to_line_col(code, cursor_pos)
        script = jedi.Script(code)
        completions = script.complete(line, col)
        for c in completions[:200]:
            name = c.name
            if not name:
                continue
            matches.append(name)
            sig = ""
            try:
                sigs = c.get_signatures()
                if sigs:
                    full_sig = sigs[0].to_string()
                    paren_idx = full_sig.find("(")
                    sig = full_sig[paren_idx:] if paren_idx != -1 else full_sig
            except Exception:
                pass
            exp_types.append(
                {
                    "text": name,
                    "type": c.type or "",
                    "signature": sig,
                }
            )
    except Exception:
        pass
    return {
        "matches": matches,
        "cursor_start": cursor_start,
        "cursor_end": cursor_pos,
        "exp_types": exp_types,
    }


_INSPECT_HEADER_RE = re.compile(
    r"^(Signature|Init signature|Call signature|Type|String form|Length|File|Subclasses|Docstring|Init docstring|Class docstring|Call docstring|Source):\s*(.*)$"
)


def _parse_ipython_inspect(raw_plain: str, fallback_name: str = "") -> dict[str, Any]:
    cleaned = _strip_ansi(raw_plain).strip()
    if not cleaned:
        return {"found": False}

    sections: dict[str, list[str]] = {}
    current_key: str | None = None

    for line in cleaned.splitlines():
        m = _INSPECT_HEADER_RE.match(line)
        if m and (current_key != "Source" or m.group(1) in ("File", "Type", "Subclasses")):
            key_raw = m.group(1)
            val_first = m.group(2)
            if "signature" in key_raw.lower():
                current_key = "Signature"
            elif "docstring" in key_raw.lower():
                current_key = "Docstring"
            else:
                current_key = key_raw
            sections.setdefault(current_key, [])
            if val_first.strip():
                sections[current_key].append(val_first)
        elif current_key is not None:
            sections[current_key].append(line)

    signature = "\n".join(sections.get("Signature", [])).strip()
    type_name = " ".join(sections.get("Type", [])).strip()
    file_path = " ".join(sections.get("File", [])).strip()
    string_form = "\n".join(sections.get("String form", [])).strip()
    docstring = "\n".join(sections.get("Docstring", [])).strip()
    if not docstring and not signature and not type_name:
        docstring = cleaned

    name = fallback_name
    if not name and signature:
        paren = signature.find("(")
        if paren > 0:
            name = signature[:paren].strip()

    return {
        "found": True,
        "name": name or fallback_name or " Objeto",
        "signature": signature,
        "type_name": type_name,
        "docstring": docstring,
        "file": file_path,
        "string_form": string_form,
        "raw_text": cleaned,
    }


def _jedi_inspect_fallback(code: str, cursor_pos: int) -> dict[str, Any]:
    cursor_pos = max(0, min(len(code), int(cursor_pos)))
    try:
        import jedi

        line, col = _offset_to_line_col(code, cursor_pos)
        script = jedi.Script(code)

        # 1. Try direct help at cursor
        helps = script.help(line, col)
        for h in helps:
            doc = (h.docstring(raw=False) or "").strip()
            sig = ""
            try:
                sig = h.get_type_hint() or ""
            except Exception:
                pass
            if doc or sig:
                if sig and doc.startswith(sig):
                    doc = doc[len(sig) :].strip()
                return {
                    "found": True,
                    "name": h.full_name or h.name or _extract_symbol_near(code, cursor_pos),
                    "signature": sig,
                    "type_name": h.type or "",
                    "docstring": doc,
                    "file": str(h.module_path) if getattr(h, "module_path", None) else "",
                    "string_form": "",
                    "raw_text": (f"{sig}\n\n{doc}" if sig else doc).strip(),
                }

        # 2. Try enclosing call signature (e.g. cursor inside func(|))
        sigs = script.get_signatures(line, col)
        for s in sigs:
            sig_str = s.to_string()
            doc = (s.docstring(raw=False) or "").strip()
            if sig_str and doc.startswith(sig_str):
                doc = doc[len(sig_str) :].strip()
            return {
                "found": True,
                "name": s.full_name or s.name or _extract_symbol_near(code, cursor_pos),
                "signature": sig_str,
                "type_name": s.type or "function",
                "docstring": doc,
                "file": str(s.module_path) if getattr(s, "module_path", None) else "",
                "string_form": "",
                "raw_text": (f"{sig_str}\n\n{doc}" if sig_str else doc).strip(),
            }
    except Exception:
        pass
    return {"found": False}


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
        key_path = (workspace_root / notebook_rel_path).resolve()
        # A filesystem operation may target a folder containing open notebooks.
        keys = [
            active
            for active in self._sessions
            if Path(active).is_relative_to(key_path)
        ]
        for active in keys:
            session = self._sessions.pop(active, None)
            self._locks.pop(active, None)
            if session:
                await session.shutdown()

    async def shutdown_all(self) -> None:
        for s in list(self._sessions.values()):
            await s.shutdown()
        self._sessions.clear()
        self._locks.clear()


kernel_registry = SaturnoKernelRegistry()
