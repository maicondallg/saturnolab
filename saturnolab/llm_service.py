from __future__ import annotations

import asyncio
import json
import os
import re
import shutil
from pathlib import Path
from typing import Any, AsyncGenerator

import httpx

from .config import config_manager


def strip_markdown_fences(code: str, cell_type: str = "code") -> str:
    if cell_type == "markdown":
        return code.strip()
    cleaned = code.strip()
    fence_match = re.match(
        r"^```[a-zA-Z0-9_-]*\s*\n([\s\S]*?)\n?```\s*$",
        cleaned,
    )
    if fence_match:
        return fence_match.group(1)
    return cleaned


def build_inline_prompt(
    instruction: str,
    cell_type: str,
    current_code: str,
    selected_text: str,
    cells_above: list[dict[str, Any]],
    cells_below: list[dict[str, Any]],
    kernel_variables: list[dict[str, Any]],
    last_error: str = "",
) -> tuple[str, str]:
    if cell_type == "markdown":
        system_prompt = (
            "You are SaturnoLab AI, a concise technical writer inside a Python notebook.\n"
            "Return ONLY the Markdown content to insert or replace in the cell. Do NOT wrap your entire response in ```markdown fences unless requested."
        )
    else:
        system_prompt = (
            "You are SaturnoLab AI, an expert Python & Data Science assistant embedded directly inside a Jupyter notebook cell.\n"
            "CRITICAL OUTPUT RULES:\n"
            "1. Return ONLY valid, executable Python code ready to paste directly into the cell (or replace the selected snippet).\n"
            "2. Do NOT include conversational explanations, greetings, or surrounding ```python markdown code fences.\n"
            "3. Reuse imports and variables that already exist in previous cells or in live kernel memory instead of redefining sample data unnecessarily.\n"
            "4. For plots (matplotlib / seaborn / plotly), write clean, readable, well-labeled charts suitable for inline notebook rendering."
        )

    parts: list[str] = []

    if kernel_variables:
        var_lines = []
        for v in kernel_variables[:30]:
            shape_part = f" {v['shape']}" if v.get("shape") else ""
            prev_part = f" -> {v['preview']}" if v.get("preview") else ""
            var_lines.append(f"- {v['name']}: {v['type']}{shape_part}{prev_part}")
        parts.append("## Live Kernel Variables in Memory\n" + "\n".join(var_lines))

    if cells_above:
        above_snippets = []
        for idx, c in enumerate(cells_above[-6:], start=1):
            src = (c.get("source") or "").strip()
            if src:
                ctype = c.get("cell_type", "code")
                above_snippets.append(f"# --- Previous {ctype} cell {idx} ---\n{src[:1200]}")
        if above_snippets:
            parts.append("## Preceding Notebook Cells\n" + "\n\n".join(above_snippets))

    if cells_below:
        below_snippets = []
        for idx, c in enumerate(cells_below[:2], start=1):
            src = (c.get("source") or "").strip()
            if src:
                below_snippets.append(f"# --- Following cell {idx} ---\n{src[:600]}")
        if below_snippets:
            parts.append("## Following Notebook Cells\n" + "\n\n".join(below_snippets))

    if current_code.strip():
        parts.append(f"## Current Active Cell Content\n{current_code}")
    else:
        parts.append("## Current Active Cell Content\n<empty cell>")

    if selected_text.strip():
        parts.append(
            "## Selected Snippet to Transform / Replace\n"
            "ONLY return the replacement code for this selected region (matching indentation if needed):\n"
            f"{selected_text}"
        )

    if last_error.strip():
        parts.append(f"## Last Execution Error / Traceback in This Cell\n{last_error[:2000]}")

    parts.append(f"## User Instruction\n{instruction}")

    user_prompt = "\n\n".join(parts)
    return system_prompt, user_prompt


async def _stream_gemini(
    system_prompt: str,
    user_prompt: str,
    api_key: str,
    model: str,
    base_url: str,
) -> AsyncGenerator[str, None]:
    if not api_key:
        raise ValueError(
            "Chave da API do Gemini não configurada. Clique no seletor de modelo no topo direito e informe sua GEMINI_API_KEY."
        )
    model_id = (model or "gemini-2.5-flash").strip()
    if model_id.startswith("models/"):
        model_id = model_id[len("models/") :]

    root = (base_url or "https://generativelanguage.googleapis.com/v1beta").rstrip("/")
    url = f"{root}/models/{model_id}:streamGenerateContent?alt=sse&key={api_key}"

    payload = {
        "system_instruction": {"parts": [{"text": system_prompt}]},
        "contents": [{"role": "user", "parts": [{"text": user_prompt}]}],
        "generationConfig": {"temperature": 0.2},
    }

    async with httpx.AsyncClient(timeout=120.0) as client:
        async with client.stream("POST", url, json=payload) as resp:
            if resp.status_code >= 400:
                body = await resp.aread()
                raise RuntimeError(
                    f"Erro Gemini ({resp.status_code}): {body.decode('utf-8', errors='replace')[:400]}"
                )
            async for line in resp.aiter_lines():
                if not line.startswith("data:"):
                    continue
                data_str = line[5:].strip()
                if not data_str or data_str == "[DONE]":
                    continue
                try:
                    chunk = json.loads(data_str)
                    for cand in chunk.get("candidates", []):
                        for part in cand.get("content", {}).get("parts", []):
                            txt = part.get("text", "")
                            if txt:
                                yield txt
                except json.JSONDecodeError:
                    continue


async def _stream_codex(
    system_prompt: str,
    user_prompt: str,
    api_key: str,
    model: str,
    base_url: str,
    reasoning_effort: str,
    workspace_dir: Path,
) -> AsyncGenerator[str, None]:
    """Stream directly from `codex exec --json` (same JSONL protocol used by @openai/codex-sdk).
    Zero node_modules required inside the Python wheel!
    """
    codex_bin = config_manager.resolve_codex_binary()
    npx_bin = shutil.which("npx")

    if codex_bin:
        cmd = [codex_bin, "exec"]
    elif npx_bin:
        cmd = [npx_bin, "--yes", "@openai/codex", "exec"]
    else:
        raise RuntimeError(
            "Codex CLI não encontrado. Instale globalmente com `npm install -g @openai/codex`."
        )

    cmd.extend(
        [
            "--json",
            "--ephemeral",
            "--skip-git-repo-check",
            "--sandbox",
            "read-only",
            "-C",
            str(workspace_dir),
        ]
    )

    if model and model.strip():
        cmd.extend(["-m", model.strip()])
    if reasoning_effort and reasoning_effort.strip():
        cmd.extend(["-c", f'model_reasoning_effort="{reasoning_effort.strip()}"'])
    if base_url and base_url.strip():
        cmd.extend(["-c", f'openai_base_url="{base_url.strip()}"'])

    cmd.append("-")

    env = dict(os.environ)
    if api_key and api_key.strip():
        env["CODEX_API_KEY"] = api_key.strip()
        env.setdefault("OPENAI_API_KEY", api_key.strip())

    combined_prompt = (
        f"{system_prompt}\n\n"
        "IMPORTANT: Do NOT run shell commands or edit files on disk. Directly answer with ONLY the code requested.\n\n"
        f"{user_prompt}"
    ).encode("utf-8")

    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        cwd=str(workspace_dir),
        env=env,
    )

    assert proc.stdin is not None
    assert proc.stdout is not None
    proc.stdin.write(combined_prompt)
    await proc.stdin.drain()
    proc.stdin.close()

    emitted_by_item: dict[str, int] = {}

    try:
        while True:
            raw_line = await proc.stdout.readline()
            if not raw_line:
                break
            line = raw_line.decode("utf-8", errors="replace").strip()
            if not line:
                continue
            try:
                evt = json.loads(line)
            except json.JSONDecodeError:
                continue

            etype = evt.get("type")
            if etype in ("item.updated", "item.completed"):
                item = evt.get("item") or {}
                if item.get("type") == "agent_message":
                    item_id = str(item.get("id", "default"))
                    full_text = str(item.get("text", ""))
                    prev_len = emitted_by_item.get(item_id, 0)
                    if len(full_text) > prev_len:
                        delta = full_text[prev_len:]
                        emitted_by_item[item_id] = len(full_text)
                        yield delta
            elif etype == "turn.failed":
                err_obj = evt.get("error") or {}
                raise RuntimeError(f"Codex falhou: {err_obj.get('message', 'Erro desconhecido')}")
            elif etype == "error":
                raise RuntimeError(f"Codex erro: {evt.get('message', 'Erro desconhecido')}")

        await proc.wait()
        if proc.returncode and proc.returncode != 0 and not emitted_by_item:
            stderr_bytes = await proc.stderr.read() if proc.stderr else b""
            err_msg = stderr_bytes.decode("utf-8", errors="replace").strip()
            if err_msg:
                raise RuntimeError(f"Codex retornou erro: {err_msg[:400]}")
    finally:
        if proc.returncode is None:
            try:
                proc.kill()
            except Exception:
                pass


async def _stream_openai_compatible(
    system_prompt: str,
    user_prompt: str,
    api_key: str,
    model: str,
    base_url: str,
) -> AsyncGenerator[str, None]:
    root = (base_url or "https://api.openai.com/v1").rstrip("/")
    url = f"{root}/chat/completions"
    headers = {"Content-Type": "application/json"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"

    payload = {
        "model": model or "gpt-4.1-mini",
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
        "temperature": 0.2,
        "stream": True,
    }

    async with httpx.AsyncClient(timeout=120.0) as client:
        async with client.stream("POST", url, headers=headers, json=payload) as resp:
            if resp.status_code >= 400:
                body = await resp.aread()
                raise RuntimeError(
                    f"Erro OpenAI-Compatible ({resp.status_code}): {body.decode('utf-8', errors='replace')[:400]}"
                )
            async for line in resp.aiter_lines():
                if not line.startswith("data:"):
                    continue
                data_str = line[5:].strip()
                if not data_str or data_str == "[DONE]":
                    continue
                try:
                    chunk = json.loads(data_str)
                    choices = chunk.get("choices", [])
                    if choices:
                        delta = choices[0].get("delta", {}).get("content", "")
                        if delta:
                            yield delta
                except json.JSONDecodeError:
                    continue


async def _stream_anthropic(
    system_prompt: str,
    user_prompt: str,
    api_key: str,
    model: str,
    base_url: str,
) -> AsyncGenerator[str, None]:
    if not api_key:
        raise ValueError("Chave da API da Anthropic não configurada.")
    root = (base_url or "https://api.anthropic.com/v1").rstrip("/")
    url = f"{root}/messages"
    headers = {
        "x-api-key": api_key,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
    }
    payload = {
        "model": model or "claude-sonnet-4-5",
        "max_tokens": 4096,
        "system": system_prompt,
        "messages": [{"role": "user", "content": user_prompt}],
        "stream": True,
    }

    async with httpx.AsyncClient(timeout=120.0) as client:
        async with client.stream("POST", url, headers=headers, json=payload) as resp:
            if resp.status_code >= 400:
                body = await resp.aread()
                raise RuntimeError(
                    f"Erro Anthropic ({resp.status_code}): {body.decode('utf-8', errors='replace')[:400]}"
                )
            async for line in resp.aiter_lines():
                if not line.startswith("data:"):
                    continue
                data_str = line[5:].strip()
                if not data_str:
                    continue
                try:
                    evt = json.loads(data_str)
                    if evt.get("type") == "content_block_delta":
                        txt = evt.get("delta", {}).get("text", "")
                        if txt:
                            yield txt
                except json.JSONDecodeError:
                    continue


async def stream_inline_generation(
    request_data: dict[str, Any],
    kernel_variables: list[dict[str, Any]],
    workspace_dir: Path,
) -> AsyncGenerator[str, None]:
    cfg = config_manager.config
    provider = request_data.get("provider") or cfg.active_provider
    prov_cfg = cfg.providers.get(provider)
    if not prov_cfg:
        raise ValueError(f"Provedor LLM desconhecido: {provider}")

    api_key = config_manager.resolve_api_key(provider)
    model = request_data.get("model") or prov_cfg.model
    base_url = prov_cfg.base_url

    cell_type = request_data.get("cell_type", "code")
    system_prompt, user_prompt = build_inline_prompt(
        instruction=request_data.get("prompt", ""),
        cell_type=cell_type,
        current_code=request_data.get("current_code", ""),
        selected_text=request_data.get("selected_text", ""),
        cells_above=request_data.get("cells_above", []),
        cells_below=request_data.get("cells_below", []),
        kernel_variables=kernel_variables if cfg.include_kernel_variables else [],
        last_error=request_data.get("last_error", ""),
    )

    if provider == "gemini":
        gen = _stream_gemini(system_prompt, user_prompt, api_key, model, base_url)
    elif provider == "codex":
        gen = _stream_codex(
            system_prompt,
            user_prompt,
            api_key,
            model,
            base_url,
            prov_cfg.reasoning_effort,
            workspace_dir,
        )
    elif provider == "openai_compatible":
        gen = _stream_openai_compatible(system_prompt, user_prompt, api_key, model, base_url)
    elif provider == "anthropic":
        gen = _stream_anthropic(system_prompt, user_prompt, api_key, model, base_url)
    else:
        raise ValueError(f"Provedor não suportado: {provider}")

    async for chunk in gen:
        yield chunk
