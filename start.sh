#!/usr/bin/env bash
# 【肥肥风筝猫】一键启动（Linux / macOS / Git Bash）
set -euo pipefail
cd "$(dirname "$0")"

NODE_MIN_MAJOR=22
NODE_MIN_MINOR=5

if ! command -v node >/dev/null 2>&1; then
  echo "[x] 没找到 node。请先安装 Node.js >= ${NODE_MIN_MAJOR}.${NODE_MIN_MINOR}：https://nodejs.org/" >&2
  exit 1
fi

NODE_VER=$(node -p "process.versions.node")
MAJOR=${NODE_VER%%.*}
_REST=${NODE_VER#*.}
MINOR=${_REST%%.*}

if [ "$MAJOR" -lt "$NODE_MIN_MAJOR" ] || { [ "$MAJOR" -eq "$NODE_MIN_MAJOR" ] && [ "$MINOR" -lt "$NODE_MIN_MINOR" ]; }; then
  echo "[x] Node 版本过低：当前 ${NODE_VER}，需要 >= ${NODE_MIN_MAJOR}.${NODE_MIN_MINOR}（要用内置的 node:sqlite）" >&2
  exit 1
fi

if [ ! -f .env ]; then
  cp .env.example .env
  echo "[i] 已从 .env.example 生成 .env —— 请按需修改（至少看一眼 ONEBOT_WS_URL 和 ADMIN_TOKEN）"
fi

echo "[*] 启动【肥肥风筝猫】（Node ${NODE_VER}）"
exec node --experimental-sqlite src/index.js
