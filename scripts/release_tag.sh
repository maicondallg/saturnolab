#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
if [ "$CURRENT_BRANCH" != "main" ]; then
  echo "❌ You must be on 'main' branch to release (current: '$CURRENT_BRANCH')."
  exit 1
fi

if [ -n "$(git status --porcelain)" ]; then
  echo "❌ Working tree is not clean. Commit or stash your changes before releasing."
  exit 1
fi

PKG_VERSION="$(python3 -c 'import tomllib; print(tomllib.load(open("pyproject.toml", "rb"))["project"]["version"])')"
INPUT_VERSION="${1:-$PKG_VERSION}"
VERSION="${INPUT_VERSION#v}"
TAG="v${VERSION}"

if [ "$VERSION" != "$PKG_VERSION" ]; then
  echo "❌ Requested tag ($TAG) does not match pyproject.toml version ($PKG_VERSION)."
  echo "   Update pyproject.toml first or run without arguments to use $PKG_VERSION."
  exit 1
fi

if git rev-parse "$TAG" >/dev/null 2>&1; then
  echo "❌ Tag '$TAG' already exists locally."
  exit 1
fi

echo "Pulling latest main from origin..."
git pull --ff-only origin main

echo "Creating annotated tag $TAG on main..."
git tag -a "$TAG" -m "Release $TAG"

echo "Pushing main and tag $TAG to origin..."
git push origin main
git push origin "$TAG"

echo "✅ Tag $TAG pushed! GitHub Actions will now build and publish to PyPI."
