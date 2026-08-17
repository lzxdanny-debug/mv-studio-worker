#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HOOK_SRC="$ROOT/scripts/git-hooks"
HOOK_DST="$(git -C "$ROOT" rev-parse --git-path hooks)"
mkdir -p "$HOOK_DST"
for hook in pre-commit; do
  cp "$HOOK_SRC/$hook" "$HOOK_DST/$hook"
  chmod +x "$HOOK_DST/$hook"
  echo "已安装: $HOOK_DST/$hook"
done
echo "完成。pre-commit 会自动递增 package.json patch 版本。"
