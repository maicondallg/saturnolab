#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "1/3 Building frontend into saturnolab/static..."
(cd "$ROOT_DIR/frontend" && npm run build)

echo "2/3 Cleaning previous dist/ artifacts..."
rm -rf "$ROOT_DIR/dist"

echo "3/3 Building Python wheel & sdist..."
(cd "$ROOT_DIR" && uv build)

echo "✅ Release artifacts ready in $ROOT_DIR/dist/:"
ls -lh "$ROOT_DIR/dist"
