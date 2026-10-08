#!/usr/bin/env bash
# 肥肥风筝猫 · 数据备份
#
# 由 systemd timer（fatcat-backup.timer）每日调用，也可以手动跑。
# 真正的快照逻辑在 scripts/backup.js 里（用 SQLite VACUUM INTO 保证一致性），
# 这里只负责：定位目录 → 调用它 → 校验产物 → 可选异地同步。
#
# 可用环境变量（也可以写在 .env 里）：
#   BACKUP_DIR          备份存放目录，默认 <项目根>/backups
#   BACKUP_KEEP         保留份数，默认 14
#   BACKUP_OFFSITE_CMD  备份成功后执行的异地同步命令，例如
#                       rclone sync "$BACKUP_DIR/latest" remote:fatcat
#                       留空则跳过（强烈建议配上，本地备份挡不住整机故障）
#   NODE_BIN            指定 node 可执行文件，默认取 PATH 里的 node
#
# 退出码：0 成功 / 非 0 失败（systemd 会记为 failed，可在管理台或 journalctl 看到）

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$APP_DIR"

log() { printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"; }
die() { printf '[%s] 错误：%s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >&2; exit 1; }

# 从 .env 里取需要的几个变量（不 source，避免把整份配置导入 shell）
if [ -f "$APP_DIR/.env" ]; then
  for key in BACKUP_DIR BACKUP_KEEP BACKUP_OFFSITE_CMD NODE_BIN; do
    if [ -z "${!key:-}" ]; then
      line="$(grep -E "^[[:space:]]*${key}[[:space:]]*=" "$APP_DIR/.env" | tail -n 1 || true)"
      if [ -n "$line" ]; then
        val="${line#*=}"
        val="${val#"${val%%[![:space:]]*}"}"
        val="${val%"${val##*[![:space:]]}"}"
        val="${val%\"}"; val="${val#\"}"
        val="${val%\'}"; val="${val#\'}"
        export "$key=$val"
      fi
    fi
  done
fi

NODE_BIN="${NODE_BIN:-node}"
command -v "$NODE_BIN" >/dev/null 2>&1 || die "找不到 node（可用 NODE_BIN 指定绝对路径）"

BACKUP_DIR="${BACKUP_DIR:-$APP_DIR/backups}"
BACKUP_KEEP="${BACKUP_KEEP:-14}"

log "开始备份 → $BACKUP_DIR（保留 $BACKUP_KEEP 份）"

# node:sqlite 在 Node 22 仍是实验特性，必须带这个 flag
"$NODE_BIN" --experimental-sqlite "$APP_DIR/scripts/backup.js" \
  --out "$BACKUP_DIR" --keep "$BACKUP_KEEP"

# 校验：最新一份目录里必须有 manifest.json，且 integrity_check 为 ok
LATEST="$(ls -1d "$BACKUP_DIR"/*/ 2>/dev/null | sort | tail -n 1 || true)"
[ -n "$LATEST" ] || die "备份目录里没有任何备份产出"
LATEST="${LATEST%/}"
[ -f "$LATEST/manifest.json" ] || die "缺少 manifest.json：$LATEST"
[ -s "$LATEST/fatcat.db" ] || die "数据库快照为空：$LATEST/fatcat.db"

if ! grep -q '"integrity": "ok"' "$LATEST/manifest.json"; then
  die "完整性检查未通过，详见 $LATEST/manifest.json"
fi

log "本地备份校验通过：$LATEST"

# 让 latest 永远指向最新一份，方便异地同步与恢复脚本直接引用（用相对目标，便于整目录搬走）
ln -sfn "$(basename "$LATEST")" "$BACKUP_DIR/latest"

if [ -n "${BACKUP_OFFSITE_CMD:-}" ]; then
  log "执行异地同步：$BACKUP_OFFSITE_CMD"
  # 故意用 eval：这条命令由运维自己在 .env 里写，需要支持重定向/管道
  if eval "$BACKUP_OFFSITE_CMD"; then
    log "异地同步完成"
  else
    die "异地同步失败（本地备份仍在 $LATEST）"
  fi
else
  log "未配置 BACKUP_OFFSITE_CMD，跳过异地同步（注意：本地备份挡不住整机故障）"
fi

log "备份流程结束"
