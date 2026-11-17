from __future__ import annotations

import argparse
import os
import socket
import threading
import time
import webbrowser
from pathlib import Path

import uvicorn

from . import __version__


def find_available_port(host: str, preferred_port: int, max_tries: int = 50) -> int:
    for offset in range(max_tries):
        port = preferred_port + offset
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                sock.bind((host, port))
                return port
            except OSError:
                continue
    return preferred_port


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(
        prog="saturnolab",
        description="SaturnoLab — Ambiente leve de notebooks Python com IA Inline integrada ao Kernel.",
    )
    parser.add_argument(
        "directory",
        nargs="?",
        default=".",
        help="Diretório do projeto para abrir no SaturnoLab (padrão: diretório atual).",
    )
    parser.add_argument(
        "-p",
        "--port",
        type=int,
        default=int(os.environ.get("SATURNOLAB_PORT", "8899")),
        help="Porta HTTP inicial (padrão: 8899; avança automaticamente se ocupada).",
    )
    parser.add_argument(
        "--host",
        default=os.environ.get("SATURNOLAB_HOST", "127.0.0.1"),
        help="Host para escutar conexões (padrão: 127.0.0.1).",
    )
    parser.add_argument(
        "--no-browser",
        action="store_true",
        help="Não abrir o navegador automaticamente ao iniciar.",
    )
    parser.add_argument(
        "--reload",
        action="store_true",
        help="Habilitar auto-reload do servidor (desenvolvimento).",
    )
    parser.add_argument(
        "-v",
        "--version",
        action="version",
        version=f"saturnolab {__version__}",
    )

    args = parser.parse_args(argv)

    workspace_path = Path(args.directory).expanduser().resolve()
    if not workspace_path.exists():
        workspace_path.mkdir(parents=True, exist_ok=True)
    elif not workspace_path.is_dir():
        parser.error(f"O caminho informado não é um diretório: {workspace_path}")

    os.environ["SATURNOLAB_WORKSPACE"] = str(workspace_path)

    port = find_available_port(args.host, args.port)
    display_host = "127.0.0.1" if args.host in ("0.0.0.0", "::") else args.host
    url = f"http://{display_host}:{port}"

    print(f"🪐 SaturnoLab v{__version__}")
    print(f"📂 Diretório : {workspace_path}")
    print(f"🌐 Servidor  : {url}")
    print("   Pressione Ctrl+C para encerrar.\n")

    if not args.no_browser:
        def _open_browser() -> None:
            time.sleep(0.8)
            try:
                webbrowser.open(url)
            except Exception:
                pass

        threading.Thread(target=_open_browser, daemon=True).start()

    uvicorn.run(
        "saturnolab.main:app",
        host=args.host,
        port=port,
        reload=args.reload,
        log_level="warning",
    )


if __name__ == "__main__":
    main()
