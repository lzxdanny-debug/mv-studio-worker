#!/usr/bin/env bash
# MV Studio 合成压测一键脚本（时长 × 并发矩阵）
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# 可通过环境变量覆盖
DURATIONS="${DURATIONS:-60,180}"
CONCURRENCY="${CONCURRENCY:-1,5,10,15}"
CLIP_SEC="${CLIP_SEC:-5}"
ASPECT="${ASPECT:-16:9}"
TMP_DIR="${TMP_DIR:-${MV_BENCH_TMP_DIR:-}}"
REPORT_DIR="${REPORT_DIR:-/tmp}"
EXTRA_ARGS="${EXTRA_ARGS:-}"

mkdir -p "$REPORT_DIR"
STAMP="$(date +%Y%m%d-%H%M%S)"
REPORT="${REPORT_DIR}/mv-compose-benchmark-${STAMP}.md"

if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "ERROR: ffmpeg 未安装。请执行: sudo apt install -y ffmpeg" >&2
  exit 1
fi
if ! command -v node >/dev/null 2>&1; then
  echo "ERROR: node 未安装。请安装 Node.js 18+。" >&2
  exit 1
fi

CMD=(
  node "$SCRIPT_DIR/benchmark-compose.mjs"
  --durations "$DURATIONS"
  --concurrency "$CONCURRENCY"
  --clip-sec "$CLIP_SEC"
  --aspect "$ASPECT"
  --report "$REPORT"
)

if [[ -n "$TMP_DIR" ]]; then
  mkdir -p "$TMP_DIR"
  CMD+=(--tmp-dir "$TMP_DIR")
fi

# shellcheck disable=SC2206
CMD+=($EXTRA_ARGS)

echo "== MV Compose Benchmark =="
echo "Durations:   $DURATIONS"
echo "Concurrency: $CONCURRENCY"
echo "Report:      $REPORT"
[[ -n "$TMP_DIR" ]] && echo "Tmp dir:     $TMP_DIR"
echo ""

"${CMD[@]}"

JSON="${REPORT%.md}.json"
echo ""
echo "Done."
echo "  Markdown: $REPORT"
echo "  JSON:     $JSON"
