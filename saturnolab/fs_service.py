from __future__ import annotations

import json
import shutil
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import nbformat

IGNORED_NAMES = {
    ".git",
    "__pycache__",
    ".ipynb_checkpoints",
    "node_modules",
    ".venv",
    "venv",
    ".mypy_cache",
    ".pytest_cache",
    ".ruff_cache",
}


def safe_resolve(workspace_root: Path, rel_path: str = "") -> Path:
    root = workspace_root.resolve()
    cleaned = rel_path.lstrip("/").strip()
    target = (root / cleaned).resolve() if cleaned else root
    if target != root and root not in target.parents:
        raise PermissionError("Acesso fora do diretório de trabalho não permitido.")
    return target


def _scan_dir_entries(
    root_resolved: Path, target: Path, recursive: bool = True, depth: int = 0, max_depth: int = 6
) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    try:
        entries = sorted(target.iterdir(), key=lambda e: (not e.is_dir(), e.name.lower()))
    except OSError:
        return items

    for entry in entries:
        if entry.name in IGNORED_NAMES or entry.name.startswith(".DS_Store"):
            continue
        try:
            stat = entry.stat()
            is_dir = entry.is_dir()
            ext = entry.suffix.lower() if not is_dir else ""
            item_type = "directory" if is_dir else ("notebook" if ext == ".ipynb" else "file")
            item_dict: dict[str, Any] = {
                "name": entry.name,
                "path": str(entry.relative_to(root_resolved)).replace("\\", "/"),
                "type": item_type,
                "extension": ext,
                "size": 0 if is_dir else stat.st_size,
                "modified": datetime.fromtimestamp(stat.st_mtime, tz=timezone.utc).isoformat(),
            }
            if is_dir and recursive and depth < max_depth:
                item_dict["children"] = _scan_dir_entries(
                    root_resolved, entry, recursive=True, depth=depth + 1, max_depth=max_depth
                )
            elif is_dir:
                item_dict["children"] = []
            items.append(item_dict)
        except OSError:
            continue
    return items


def list_directory(
    workspace_root: Path, rel_path: str = "", recursive: bool = False
) -> dict[str, Any]:
    root_resolved = workspace_root.resolve()
    target = safe_resolve(workspace_root, rel_path)
    if not target.exists():
        raise FileNotFoundError(f"Caminho não encontrado: {rel_path}")
    if not target.is_dir():
        raise ValueError(f"Não é um diretório: {rel_path}")

    items = _scan_dir_entries(root_resolved, target, recursive=recursive)

    return {
        "workspace_root": str(root_resolved),
        "current_path": ""
        if target == root_resolved
        else str(target.relative_to(root_resolved)).replace("\\", "/"),
        "items": items,
    }


def _normalize_source(src: Any) -> str:
    if isinstance(src, list):
        return "".join(src)
    return str(src or "")


def _serialize_output(out: Any) -> dict[str, Any]:
    out_type = out.get("output_type", "stream")
    if out_type == "stream":
        return {
            "output_type": "stream",
            "name": out.get("name", "stdout"),
            "text": _normalize_source(out.get("text", "")),
        }
    elif out_type in ("display_data", "execute_result"):
        raw_data = out.get("data", {})
        clean_data: dict[str, Any] = {}
        for mime, val in raw_data.items():
            if isinstance(val, (dict, list)) and mime.endswith("+json"):
                clean_data[mime] = val
            else:
                clean_data[mime] = _normalize_source(val)
        return {
            "output_type": out_type,
            "data": clean_data,
            "execution_count": out.get("execution_count"),
        }
    elif out_type == "error":
        return {
            "output_type": "error",
            "ename": out.get("ename", "Error"),
            "evalue": out.get("evalue", ""),
            "traceback": list(out.get("traceback", [])),
        }
    return {"output_type": out_type, "text": str(out)}


def _deserialize_output_to_nbformat(out: dict[str, Any]) -> Any:
    out_type = out.get("output_type", "stream")
    if out_type == "stream":
        return nbformat.v4.new_output(
            output_type="stream",
            name=out.get("name", "stdout"),
            text=out.get("text", ""),
        )
    elif out_type == "execute_result":
        return nbformat.v4.new_output(
            output_type="execute_result",
            data=out.get("data", {}),
            execution_count=out.get("execution_count"),
        )
    elif out_type == "display_data":
        return nbformat.v4.new_output(
            output_type="display_data",
            data=out.get("data", {}),
        )
    elif out_type == "error":
        return nbformat.v4.new_output(
            output_type="error",
            ename=out.get("ename", "Error"),
            evalue=out.get("evalue", ""),
            traceback=out.get("traceback", []),
        )
    return nbformat.v4.new_output(output_type="stream", name="stdout", text=str(out))


def read_notebook(workspace_root: Path, rel_path: str) -> dict[str, Any]:
    target = safe_resolve(workspace_root, rel_path)
    if not target.exists():
        raise FileNotFoundError(f"Notebook não encontrado: {rel_path}")

    raw_text = target.read_text(encoding="utf-8")
    if not raw_text.strip():
        raw_nb: dict[str, Any] = {"cells": [], "metadata": {}}
    else:
        try:
            parsed = json.loads(raw_text)
            if isinstance(parsed, dict) and parsed.get("nbformat", 4) >= 4:
                raw_nb = parsed
            else:
                nb_obj = nbformat.reads(raw_text, as_version=4)
                raw_nb = {"cells": nb_obj.cells, "metadata": dict(nb_obj.metadata)}
        except Exception:
            nb_obj = nbformat.reads(raw_text, as_version=4)
            raw_nb = {"cells": nb_obj.cells, "metadata": dict(nb_obj.metadata)}

    cells: list[dict[str, Any]] = []
    for c in raw_nb.get("cells", []):
        cell_id = c.get("id") or uuid.uuid4().hex[:8]
        cell_type = c.get("cell_type", "code")
        if cell_type not in ("code", "markdown"):
            cell_type = "code"
        cells.append(
            {
                "id": cell_id,
                "cell_type": cell_type,
                "source": _normalize_source(c.get("source", "")),
                "execution_count": c.get("execution_count") if cell_type == "code" else None,
                "outputs": [_serialize_output(o) for o in c.get("outputs", [])]
                if cell_type == "code"
                else [],
                "metadata": dict(c.get("metadata", {})),
            }
        )

    if not cells:
        cells.append(
            {
                "id": uuid.uuid4().hex[:8],
                "cell_type": "code",
                "source": "",
                "execution_count": None,
                "outputs": [],
                "metadata": {},
            }
        )

    return {
        "path": str(target.relative_to(workspace_root.resolve())).replace("\\", "/"),
        "name": target.name,
        "metadata": dict(raw_nb.get("metadata", {})),
        "cells": cells,
    }


def save_notebook(
    workspace_root: Path,
    rel_path: str,
    cells: list[dict[str, Any]],
    metadata: dict[str, Any] | None = None,
) -> dict[str, Any]:
    target = safe_resolve(workspace_root, rel_path)
    target.parent.mkdir(parents=True, exist_ok=True)

    nb = nbformat.v4.new_notebook()
    default_meta = {
        "kernelspec": {
            "display_name": "Python 3 (ipykernel)",
            "language": "python",
            "name": "python3",
        },
        "language_info": {
            "name": "python",
            "file_extension": ".py",
            "mimetype": "text/x-python",
        },
    }
    if metadata:
        default_meta.update(metadata)
    nb.metadata = default_meta

    nb_cells = []
    for c in cells:
        ctype = c.get("cell_type", "code")
        src = c.get("source", "")
        cid = c.get("id") or uuid.uuid4().hex[:8]
        cmeta = c.get("metadata", {})
        if ctype == "markdown":
            cell_obj = nbformat.v4.new_markdown_cell(source=src, metadata=cmeta)
            cell_obj["id"] = cid
        else:
            outputs = [
                _deserialize_output_to_nbformat(o)
                for o in c.get("outputs", [])
                if isinstance(o, dict)
            ]
            cell_obj = nbformat.v4.new_code_cell(
                source=src,
                execution_count=c.get("execution_count"),
                outputs=outputs,
                metadata=cmeta,
            )
            cell_obj["id"] = cid
        nb_cells.append(cell_obj)

    nb.cells = nb_cells
    nbformat.write(nb, str(target))
    return {
        "saved": True,
        "path": str(target.relative_to(workspace_root.resolve())).replace("\\", "/"),
        "modified": datetime.now(timezone.utc).isoformat(),
    }


def create_notebook(
    workspace_root: Path, folder_rel_path: str = "", filename: str | None = None
) -> dict[str, Any]:
    folder = safe_resolve(workspace_root, folder_rel_path)
    folder.mkdir(parents=True, exist_ok=True)

    if filename:
        if "/" in filename or "\\" in filename:
            raise ValueError("Use apenas o nome do notebook.")
        if not filename.endswith(".ipynb"):
            filename += ".ipynb"
        candidate = folder / filename
        if candidate.exists():
            raise FileExistsError(f"Já existe '{filename}' nesta pasta.")
    else:
        idx = 1
        candidate = folder / "Untitled.ipynb"
        while candidate.exists():
            candidate = folder / f"Untitled{idx}.ipynb"
            idx += 1

    rel = str(candidate.relative_to(workspace_root.resolve())).replace("\\", "/")
    initial_cells = [
        {
            "id": uuid.uuid4().hex[:8],
            "cell_type": "code",
            "source": "",
            "execution_count": None,
            "outputs": [],
            "metadata": {},
        }
    ]
    save_notebook(workspace_root, rel, initial_cells)
    return read_notebook(workspace_root, rel)


def create_folder(workspace_root: Path, folder_rel_path: str, name: str) -> dict[str, Any]:
    new_dir = safe_resolve(workspace_root, str(Path(folder_rel_path) / name))
    new_dir.mkdir(parents=True, exist_ok=True)
    return {
        "created": True,
        "path": str(new_dir.relative_to(workspace_root.resolve())).replace("\\", "/"),
    }


def rename_entry(workspace_root: Path, old_rel_path: str, new_name: str) -> dict[str, Any]:
    src = safe_resolve(workspace_root, old_rel_path)
    if not src.exists():
        raise FileNotFoundError(f"Item não encontrado: {old_rel_path}")
    if "/" in new_name or "\\" in new_name:
        raise ValueError("Use apenas o novo nome do arquivo ou diretório.")
    dst = src.parent / new_name
    dst_resolved = dst.resolve()
    if workspace_root.resolve() not in dst_resolved.parents:
        raise PermissionError("Destino inválido.")
    if dst_resolved.exists():
        raise FileExistsError(f"Já existe um item chamado '{new_name}'.")
    src.rename(dst_resolved)
    return {
        "old_path": old_rel_path,
        "new_path": str(dst_resolved.relative_to(workspace_root.resolve())).replace("\\", "/"),
        "name": dst_resolved.name,
    }


def delete_entry(workspace_root: Path, rel_path: str) -> dict[str, Any]:
    target = safe_resolve(workspace_root, rel_path)
    if target == workspace_root.resolve():
        raise PermissionError("Não é possível remover o diretório raiz.")
    if not target.exists():
        raise FileNotFoundError(f"Item não encontrado: {rel_path}")
    if target.is_dir():
        shutil.rmtree(target)
    else:
        target.unlink()
    return {"deleted": True, "path": rel_path}


def read_text_file(workspace_root: Path, rel_path: str, max_bytes: int = 512_000) -> dict[str, Any]:
    target = safe_resolve(workspace_root, rel_path)
    if not target.exists() or target.is_dir():
        raise FileNotFoundError(f"Arquivo não encontrado: {rel_path}")
    with target.open("rb") as handle:
        size = target.stat().st_size
        raw = handle.read(max_bytes + 1)
    truncated = len(raw) > max_bytes
    content = raw[:max_bytes].decode("utf-8", errors="replace")
    return {
        "path": str(target.relative_to(workspace_root.resolve())).replace("\\", "/"),
        "name": target.name,
        "content": content,
        "truncated": truncated,
        "size": size,
    }


def write_text_file(workspace_root: Path, rel_path: str, content: str) -> dict[str, Any]:
    target = safe_resolve(workspace_root, rel_path)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content, encoding="utf-8")
    return {
        "saved": True,
        "path": str(target.relative_to(workspace_root.resolve())).replace("\\", "/"),
    }


def create_text_file(
    workspace_root: Path, folder_rel_path: str = "", filename: str = "script.py"
) -> dict[str, Any]:
    folder = safe_resolve(workspace_root, folder_rel_path)
    folder.mkdir(parents=True, exist_ok=True)
    name = filename.strip() or "script.py"
    if "/" in name or "\\" in name:
        raise ValueError("Use apenas o nome do arquivo.")
    candidate = folder / name
    if candidate.exists():
        stem = candidate.stem
        suffix = candidate.suffix
        idx = 1
        while candidate.exists():
            candidate = folder / f"{stem}_{idx}{suffix}"
            idx += 1
    candidate.write_text("", encoding="utf-8")
    rel = str(candidate.relative_to(workspace_root.resolve())).replace("\\", "/")
    return read_text_file(workspace_root, rel)


def plan_move_entries(
    workspace_root: Path, paths: list[str], target_folder: str = ""
) -> list[tuple[Path, Path, str]]:
    root_resolved = workspace_root.resolve()
    dst_dir = safe_resolve(workspace_root, target_folder)
    if not dst_dir.exists() or not dst_dir.is_dir():
        raise ValueError(f"Pasta de destino inválida: {target_folder}")

    planned: list[tuple[Path, Path, str]] = []
    for rel_path in sorted(set(paths), key=len):
        src = safe_resolve(workspace_root, rel_path)
        if not src.exists() or src == root_resolved:
            raise ValueError("Origem inválida.")
        if any(parent == src or parent in src.parents for parent, _, _ in planned):
            continue
        if src.is_dir() and (dst_dir == src or src in dst_dir.parents):
            raise ValueError(f"Não é possível mover a pasta '{src.name}' para dentro dela mesma.")
        dst = (dst_dir / src.name).resolve()
        if dst == src:
            continue
        if root_resolved not in dst.parents:
            raise PermissionError("Destino fora do diretório de trabalho.")
        if dst.exists() or any(target == dst for _, target, _ in planned):
            raise FileExistsError(f"Já existe '{src.name}' na pasta de destino.")
        planned.append((src, dst, rel_path))
    return planned


def move_entries(workspace_root: Path, paths: list[str], target_folder: str = "") -> dict[str, Any]:
    root_resolved = workspace_root.resolve()
    planned = plan_move_entries(workspace_root, paths, target_folder)
    moved: list[dict[str, str]] = []
    for src, dst, rel_path in planned:
        src.rename(dst)
        moved.append(
            {
                "old_path": rel_path,
                "new_path": str(dst.relative_to(root_resolved)).replace("\\", "/"),
                "name": dst.name,
            }
        )
    return {"moved": moved}


def delete_entries(workspace_root: Path, paths: list[str]) -> dict[str, Any]:
    root_resolved = workspace_root.resolve()
    deleted: list[str] = []
    # Sort shortest paths first so parent directories are removed cleanly
    for rel_path in sorted(set(paths), key=len):
        try:
            target = safe_resolve(workspace_root, rel_path)
        except PermissionError:
            continue
        if target == root_resolved or not target.exists():
            continue
        if target.is_dir():
            shutil.rmtree(target)
        else:
            target.unlink()
        deleted.append(rel_path)
    return {"deleted": deleted}


def copy_entries(workspace_root: Path, paths: list[str], target_folder: str = "") -> dict[str, Any]:
    root = workspace_root.resolve()
    destination = safe_resolve(root, target_folder)
    if not destination.is_dir():
        raise ValueError("Pasta de destino inválida.")
    sources = []
    for path in sorted(set(paths), key=len):
        source = safe_resolve(root, path)
        if source == root or not source.exists():
            raise ValueError("Origem inválida.")
        if any(parent == source or parent in source.parents for parent in sources):
            continue
        if source.is_dir() and (source == destination or source in destination.parents):
            raise ValueError("Não é possível copiar uma pasta para dentro dela mesma.")
        if source.is_symlink() or (source.is_dir() and any(p.is_symlink() for p in source.rglob('*'))):
            raise ValueError("A cópia de links simbólicos não é suportada.")
        sources.append(source)
    copied = []
    for source in sources:
        target = destination / source.name
        counter = 1
        while target.exists():
            target = destination / f"{source.stem}_copy{counter}{source.suffix}"
            counter += 1
        if source.is_dir():
            shutil.copytree(source, target)
        else:
            shutil.copy2(source, target)
        copied.append(str(target.relative_to(root)))
    return {"copied": copied}
