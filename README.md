# SaturnoLab

**SaturnoLab** (`saturnolab`) is a fast, lightweight, `.ipynb`-compatible Python notebook environment built from the ground up with **Inline AI (`Ctrl+I` / `Ctrl+K`)** connected directly to live Python kernel memory.

## Features

- **100% `.ipynb` Compatible**: Open, edit, execute, and save standard Jupyter notebooks (`nbformat` v4).
- **Zero-bloat Web UI**: Built with React, CodeMirror 6, and FastAPI (~305 KB gzipped) with 6 technical themes (*Graphite*, *Obsidian*, *Gruvbox*, *Nord*, *Jupyter Light*, *Warm Stone*).
- **Inline Cell AI (`Ctrl+I` / `Ctrl+K`)**:
  - Generate or edit Python code directly inside any cell or over a selected snippet.
  - Automatically injects **live kernel variable schemas** (`DataFrame` shapes, column names, `dtypes`, array dimensions) and preceding cell context into the prompt.
  - Instant `Tab` to accept, `Shift+Tab` to toggle *Replace* vs *Append*, and `Ctrl+Enter` to accept & execute immediately.
- **Multi-Provider LLM Support**:
  - **Google Gemini API** (`gemini-2.5-flash`, `gemini-2.5-pro`, etc.)
  - **OpenAI Codex CLI / SDK** (`@openai/codex`)
  - **OpenAI-compatible APIs** (OpenAI, local **Ollama**, OpenRouter, LM Studio)
  - **Anthropic Claude API**
- **Automatic Virtualenv Detection**: Automatically detects `.venv` / `venv` / `$VIRTUAL_ENV` in the target project folder.

---

## Installation

```bash
pip install saturnolab

# Optional: include common data science stack (pandas, numpy, matplotlib, seaborn)
pip install "saturnolab[data]"
```

Or install globally as an isolated CLI tool with **`uv`**:

```bash
uv tool install saturnolab
```

---

## Usage

Run `saturnolab` inside **any** project directory, just like `jupyter lab`:

```bash
# Open in the current directory
saturnolab

# Or point to any folder
saturnolab /path/to/project

# Custom port or headless server mode
saturnolab --port 8900 --no-browser
```

---

## Keyboard Shortcuts

| Shortcut | Action |
| --- | --- |
| `Ctrl + I` or `Ctrl + K` | Open Inline AI inside active cell or selection |
| `Shift + Tab` | Toggle between **Replace cell** and **Append to end** |
| `Tab` / `Enter` | Accept generated code |
| `Ctrl + Enter` | Run active cell (or Accept & Run in AI preview) |
| `Shift + Enter` | Run active cell and advance |
| `Alt + Enter` | Run active cell and insert new cell below |
| `Alt + ↑ / ↓` | Move cell up / down |
| `Ctrl + M` | Toggle cell between Python and Markdown |
| `Ctrl + Shift + Backspace` | Delete active cell |
| `Ctrl + S` | Save notebook |
