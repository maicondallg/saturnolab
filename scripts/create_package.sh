#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "1/4 Installing frontend dependencies (if needed) & building into saturnolab/static..."
if [ ! -d "$ROOT_DIR/frontend/node_modules" ]; then
  (cd "$ROOT_DIR/frontend" && npm ci)
fi
(cd "$ROOT_DIR/frontend" && npm run build)

echo "2/4 Cleaning previous dist/ artifacts..."
rm -rf "$ROOT_DIR/dist"

echo "3/4 Building Python wheel & sdist..."
(cd "$ROOT_DIR" && uv build)

echo "4/4 Checking package metadata with twine..."
if command -v uvx >/dev/null 2>&1; then
  (cd "$ROOT_DIR" && uvx twine check dist/*)
else
  echo "⚠️  uvx not found; skipping twine check."
fi

echo "✅ Package artifacts ready in $ROOT_DIR/dist/:"
ls -lh "$ROOT_DIR/dist"
