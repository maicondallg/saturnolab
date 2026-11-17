from __future__ import annotations

import json
import os
import shutil
import tempfile
from pathlib import Path
from typing import Any

from pydantic import BaseModel, Field

CONFIG_DIR = Path.home() / ".saturnolab"
CONFIG_FILE = CONFIG_DIR / "config.json"
LEGACY_CONFIG_FILE = Path.home() / ".saturno" / "config.json"

VALID_PROVIDERS = {"gemini", "codex", "openai_compatible", "anthropic"}

VALID_THEMES = {
    "jupyter_dark",
    "catppuccin",
    "graphite",
    "obsidian",
    "gruvbox",
    "nord",
    "paper",
    "solarized_light",
    "dark",
    "light",
}


class ProviderSettings(BaseModel):
    api_key: str = ""
    model: str = ""
    base_url: str = ""
    reasoning_effort: str = "low"


class TableOutputSettings(BaseModel):
    wrap: str = "nowrap"  # nowrap | wrap
    density: str = "normal"  # compact | normal | comfortable
    font_size: int = 13  # 12 | 13 | 14
    max_col_width: int = 280  # 180 | 280 | 420 | 0 (unlimited)
    align: str = "auto"  # auto | left | right
    height: str = "limited"  # limited | full
    sticky_headers: bool = True
    highlight_types: bool = True
    show_grid: bool = True


class SaturnoConfig(BaseModel):
    active_provider: str = "gemini"  # gemini | codex | openai_compatible | anthropic
    theme: str = "graphite"
    default_ai_apply_mode: str = "replace_cell"  # replace_cell | append_cell
    include_kernel_variables: bool = True
    notebook_layout: str = "centered"  # centered | expanded
    sidebar_position: str = "left"  # left | right
    sidebar_width: int = 280
    show_line_numbers: bool = True
    auto_scroll_on_run: bool = True
    output_display: str = "expanded"
    show_modified_time: bool = True
    confirm_kernel_restart: bool = False
    editor_font_size: int = 14
    table_output: TableOutputSettings = Field(default_factory=TableOutputSettings)
    providers: dict[str, ProviderSettings] = Field(
        default_factory=lambda: {
            "gemini": ProviderSettings(
                api_key="",
                model="gemini-2.5-flash",
                base_url="https://generativelanguage.googleapis.com/v1beta",
            ),
            "codex": ProviderSettings(
                api_key="",
                model="",
                base_url="",
                reasoning_effort="low",
            ),
            "openai_compatible": ProviderSettings(
                api_key="",
                model="gpt-4.1-mini",
                base_url="https://api.openai.com/v1",
            ),
            "anthropic": ProviderSettings(
                api_key="",
                model="claude-sonnet-4-5",
                base_url="https://api.anthropic.com/v1",
            ),
        }
    )


class ConfigManager:
    def __init__(self) -> None:
        self._migrate_legacy_if_needed()
        self._config = self._load()
        self._workspace_path = self._resolve_initial_workspace()

    def _migrate_legacy_if_needed(self) -> None:
        if not CONFIG_FILE.exists() and LEGACY_CONFIG_FILE.exists():
            try:
                CONFIG_DIR.mkdir(parents=True, exist_ok=True)
                shutil.copy2(LEGACY_CONFIG_FILE, CONFIG_FILE)
            except Exception:
                pass

    def _resolve_initial_workspace(self) -> Path:
        env_ws = (
            os.environ.get("SATURNOLAB_WORKSPACE", "").strip()
            or os.environ.get("SATURNO_WORKSPACE", "").strip()
        )
        if env_ws:
            target = Path(env_ws).expanduser().resolve()
            target.mkdir(parents=True, exist_ok=True)
            return target
        return Path.cwd().resolve()

    def _load(self) -> SaturnoConfig:
        cfg = SaturnoConfig()
        if CONFIG_FILE.exists():
            try:
                raw = json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
                # Ignore deprecated workspace_dir key from older configs
                raw.pop("workspace_dir", None)
                loaded = SaturnoConfig.model_validate(raw)
                for key, default_val in cfg.providers.items():
                    if key not in loaded.providers:
                        loaded.providers[key] = default_val
                cfg = loaded
            except Exception:
                pass
        return cfg

    def save(self) -> None:
        CONFIG_DIR.mkdir(parents=True, exist_ok=True)
        payload = json.dumps(self._config.model_dump(), indent=2, ensure_ascii=False)
        fd, tmp_name = tempfile.mkstemp(prefix=".config.", suffix=".tmp", dir=str(CONFIG_DIR))
        tmp_path = Path(tmp_name)
        try:
            if os.name != "nt":
                try:
                    os.fchmod(fd, 0o600)
                except OSError:
                    pass
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                handle.write(payload)
            os.replace(tmp_path, CONFIG_FILE)
        except Exception:
            tmp_path.unlink(missing_ok=True)
            raise

    @property
    def config(self) -> SaturnoConfig:
        return self._config

    def get_workspace_path(self) -> Path:
        if not self._workspace_path.exists():
            self._workspace_path.mkdir(parents=True, exist_ok=True)
        return self._workspace_path

    def set_workspace_path(self, new_dir: str) -> Path:
        target = Path(new_dir).expanduser().resolve()
        if not target.exists() or not target.is_dir():
            raise ValueError(f"Diretório não encontrado: {new_dir}")
        self._workspace_path = target
        return target

    def update_settings(self, patch: dict[str, Any]) -> SaturnoConfig:
        if "active_provider" in patch and patch["active_provider"] in VALID_PROVIDERS:
            self._config.active_provider = str(patch["active_provider"])
        if "theme" in patch and patch["theme"] in VALID_THEMES:
            self._config.theme = str(patch["theme"])
        if "default_ai_apply_mode" in patch and patch["default_ai_apply_mode"] in (
            "replace_cell",
            "append_cell",
        ):
            self._config.default_ai_apply_mode = patch["default_ai_apply_mode"]
        if "include_kernel_variables" in patch:
            self._config.include_kernel_variables = bool(patch["include_kernel_variables"])
        if "notebook_layout" in patch and patch["notebook_layout"] in ("centered", "expanded"):
            self._config.notebook_layout = str(patch["notebook_layout"])
        if "sidebar_position" in patch and patch["sidebar_position"] in ("left", "right"):
            self._config.sidebar_position = str(patch["sidebar_position"])
        if "sidebar_width" in patch and isinstance(patch["sidebar_width"], (int, float)):
            self._config.sidebar_width = max(180, min(640, int(patch["sidebar_width"])))
        if "show_line_numbers" in patch:
            self._config.show_line_numbers = bool(patch["show_line_numbers"])
        if patch.get("output_display") in ("expanded", "limited", "collapsed"):
            self._config.output_display = patch["output_display"]
        if "auto_scroll_on_run" in patch:
            self._config.auto_scroll_on_run = bool(patch["auto_scroll_on_run"])
        if "show_modified_time" in patch:
            self._config.show_modified_time = bool(patch["show_modified_time"])
        if "confirm_kernel_restart" in patch:
            self._config.confirm_kernel_restart = bool(patch["confirm_kernel_restart"])
        if "editor_font_size" in patch and isinstance(patch["editor_font_size"], (int, float)):
            self._config.editor_font_size = max(11, min(22, int(patch["editor_font_size"])))
        if "table_output" in patch and isinstance(patch["table_output"], dict):
            tbl = patch["table_output"]
            cur = self._config.table_output
            if tbl.get("wrap") in ("nowrap", "wrap"):
                cur.wrap = tbl["wrap"]
            if tbl.get("density") in ("compact", "normal", "comfortable"):
                cur.density = tbl["density"]
            if isinstance(tbl.get("font_size"), (int, float)):
                cur.font_size = max(11, min(16, int(tbl["font_size"])))
            if isinstance(tbl.get("max_col_width"), (int, float)):
                cur.max_col_width = max(0, min(1200, int(tbl["max_col_width"])))
            if tbl.get("align") in ("auto", "left", "right"):
                cur.align = tbl["align"]
            if tbl.get("height") in ("limited", "full"):
                cur.height = tbl["height"]
            if "sticky_headers" in tbl:
                cur.sticky_headers = bool(tbl["sticky_headers"])
            if "highlight_types" in tbl:
                cur.highlight_types = bool(tbl["highlight_types"])
            if "show_grid" in tbl:
                cur.show_grid = bool(tbl["show_grid"])
        if "providers" in patch and isinstance(patch["providers"], dict):
            for prov_name, prov_data in patch["providers"].items():
                if not isinstance(prov_data, dict):
                    continue
                existing = self._config.providers.get(prov_name, ProviderSettings())
                updated_dict = existing.model_dump()
                for k, v in prov_data.items():
                    if k == "api_key" and v == "********":
                        continue
                    if k in updated_dict and v is not None:
                        updated_dict[k] = v
                self._config.providers[prov_name] = ProviderSettings(**updated_dict)
        self.save()
        return self._config

    def resolve_api_key(self, provider: str) -> str:
        prov = self._config.providers.get(provider)
        if prov and prov.api_key.strip():
            return prov.api_key.strip()
        env_map = {
            "gemini": ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
            "codex": ["CODEX_API_KEY", "OPENAI_API_KEY"],
            "openai_compatible": ["OPENAI_API_KEY"],
            "anthropic": ["ANTHROPIC_API_KEY"],
        }
        for env_name in env_map.get(provider, []):
            val = os.environ.get(env_name, "").strip()
            if val:
                return val
        return ""

    @staticmethod
    def resolve_codex_binary() -> str | None:
        found = shutil.which("codex")
        if found:
            return found
        local_bin = Path.home() / ".local" / "bin" / "codex"
        if local_bin.exists():
            return str(local_bin)
        return None

    def public_dict(self) -> dict[str, Any]:
        data = self._config.model_dump()
        codex_bin = self.resolve_codex_binary()
        npx_bin = shutil.which("npx")
        codex_auth_exists = (Path.home() / ".codex" / "auth.json").exists()

        providers_out: dict[str, Any] = {}
        for name, p in data["providers"].items():
            resolved_key = self.resolve_api_key(name)
            providers_out[name] = {
                **p,
                "api_key": "********" if p.get("api_key") else "",
                "has_key": bool(resolved_key),
            }
        return {
            **data,
            "workspace_dir": str(self.get_workspace_path()),
            "providers": providers_out,
            "codex_status": {
                "cli_installed": bool(codex_bin),
                "auth_found": codex_auth_exists,
                "sdk_ready": bool(codex_bin or npx_bin),
            },
        }


config_manager = ConfigManager()
