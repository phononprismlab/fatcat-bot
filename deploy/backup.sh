#!/usr/bin/env bash
# 肥肥风筝猫 · 数据备份
#
# 由 systemd timer（fatcat-backup.timer）每日调用，也可以手动跑。
# 真正的快照逻辑在 scripts/backup.js 里（用 SQLite VACUUM INTO 保证一致性），
# 这里只负责：定位目录 → 调用它 → 校验产物 → 可选异地同步。
#
# 两种运行环境都能跑：
#   1. 裸机（宿主机有 node）：直接本地跑 scripts/backup.js。
#   2. 一体化 Docker 部署（宿主机只装了 Docker，没有 node）：
#      自动改走 fatcat-bot 容器内执行（容器里有 node，且数据卷已挂好），
#      校验也在容器内完成。无需在宿主机另装 node。
#
# 可用环境变量（也可以写在 .env 里）：
#   BACKUP_DIR          备份存放目录，默认 <项目根>/backups
#                       注意：Docker 模式下备份写在容器数据卷 /data/backups，
#                       与宿主机共享同一个 named volume，恢复时从数据卷取即可。
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

log() { printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >&2; }
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
BACKUP_DIR="${BACKUP_DIR:-$APP_DIR/backups}"
BACKUP_KEEP="${BACKUP_KEEP:-14}"

# 选择运行方式：裸机（有 node）/ Docker 容器（宿主机只有 Docker）
RUN_IN_CONTAINER=0
if ! command -v "$NODE_BIN" >/dev/null 2>&1; then
  if command -v docker >/dev/null 2>&1 && [ -n "$(docker ps -q -f name='^fatcat-bot$' 2>/dev/null)" ]; then
    RUN_IN_CONTAINER=1
  else
    die "找不到 node（可用 NODE_BIN 指定绝对路径），且未检测到运行中的 fatcat-bot 容器"
  fi
fi

if [ "$RUN_IN_CONTAINER" -eq 1 ]; then
  log "宿主机无 node，改用 fatcat-bot 容器内执行备份（写入数据卷 /data/backups）"
  docker exec fatcat-bot node --experimental-sqlite scripts/backup.js \
    --out /data/backups --keep "$BACKUP_KEEP"
else
  log "开始备份 → $BACKUP_DIR（保留 $BACKUP_KEEP 份）"
  mkdir -p "$BACKUP_DIR"
  "$NODE_BIN" --experimental-sqlite "$APP_DIR/scripts/backup.js" \
    --out "$BACKUP_DIR" --keep "$BACKUP_KEEP"
fi

# 校验：最新一份目录里必须有 manifest.json，且 integrity_check 为 ok。
# Docker 模式下直接在容器内读同一份数据卷。
if [ "$RUN_IN_CONTAINER" -eq 1 ]; then
  docker exec fatcat-bot sh -c '
    set -e
    LATEST="$(ls -1d /data/backups/*/ 2>/dev/null | sort | tail -n 1 || true)"
    [ -n "$LATEST" ] || { echo "备份目录里没有任何备份产出"; exit 1; }
    LATEST="${LATEST%/}"
    [ -f "$LATEST/manifest.json" ] || { echo "缺少 manifest.json：$LATEST"; exit 1; }
    [ -s "$LATEST/fatcat.db" ] || { echo "数据库快照为空：$LATEST"; exit 1; }
    grep -q "\"integrity\": \"ok\"" "$LATEST/manifest.json" || { echo "完整性检查未通过，详见 $LATEST/manifest.json"; exit 1; }
    ln -sfn "$(basename "$LATEST")" /data/backups/latest
    echo "本地备份校验通过：$LATEST"
  '
else
  LATEST="$(ls -1d "$BACKUP_DIR"/*/ 2>/dev/null | sort | tail -n 1 || true)"
  [ -n "$LATEST" ] || die "备份目录里没有任何备份产出"
  LATEST="${LATEST%/}"
  [ -f "$LATEST/manifest.json" ] || die "缺少 manifest.json：$LATEST"
  [ -s "$LATEST/fatcat.db" ] || die "数据库快照为空：$LATEST"

  if ! grep -q '"integrity": "ok"' "$LATEST/manifest.json"; then
    die "完整性检查未通过，详见 $LATEST/manifest.json"
  fi

  log "本地备份校验通过：$LATEST"

  # 让 latest 永远指向最新一份，方便异地同步与恢复脚本直接引用（用相对目标，便于整目录搬走）
  ln -sfn "$(basename "$LATEST")" "$BACKUP_DIR/latest"
fi

if [ -n "${BACKUP_OFFSITE_CMD:-}" ]; then
  if [ "$RUN_IN_CONTAINER" -eq 1 ]; then
    log "容器内执行异地同步：$BACKUP_OFFSITE_CMD"
    # 故意用 eval：这条命令由运维自己在 .env 里写，需要支持重定向/管道
    docker exec -e "BACKUP_OFFSITE_CMD=$BACKUP_OFFSITE_CMD" fatcat-bot sh -c "$BACKUP_OFFSITE_CMD" \
      || die "异地同步失败（本地备份仍在数据卷 /data/backups）"
  else
    log "执行异地同步：$BACKUP_OFFSITE_CMD"
    # 故意用 eval：这条命令由运维自己在 .env 里写，需要支持重定向/管道
    if eval "$BACKUP_OFFSITE_CMD"; then
      log "异地同步完成"
    else
      die "异地同步失败（本地备份仍在 $LATEST）"
    fi
  fi
else
  log "未配置 BACKUP_OFFSITE_CMD，跳过异地同步（注意：本地备份挡不住整机故障）"
fi

log "备份流程结束"
