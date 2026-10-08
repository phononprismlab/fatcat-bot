#!/usr/bin/env bash
# 肥肥风筝猫 · systemd 安装脚本（幂等，可重复执行）
#
# 做四件事：
#   1. 检查 Node 版本（需要 >= 22.5.0，node:sqlite 才存在）
#   2. 建服务账号 + 数据目录
#   3. 把 deploy/*.service / *.timer 里的占位符替换后装进 /etc/systemd/system/
#   4. 开机自启 + 立刻启动（含每日备份定时器）
#
# 用法：
#   sudo bash deploy/install-systemd.sh [选项]
#
# 选项：
#   --dir <路径>        项目目录，默认取本脚本的上一级
#   --user <账号>       以哪个账号运行，默认 fatcat（不存在会自动创建为系统账号）
#   --group <组>        默认取该账号的主组
#   --node <路径>       node 可执行文件，默认取 PATH 里的 node
#   --backup-dir <路径> 备份目录，默认 <项目目录>/backups
#   --no-backup-timer   不安装每日备份定时器
#   --dry-run           不写任何文件、不碰 systemd，只把渲染结果打印出来
#   -h, --help          看这段帮助
#
# 重复执行是安全的：单元文件会被覆盖重写，账号/目录已存在就跳过。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

APP_DIR=""
RUN_USER="fatcat"
RUN_GROUP=""
NODE_BIN=""
BACKUP_DIR=""
WITH_BACKUP=1
DRY_RUN=0

UNIT_DIR="/etc/systemd/system"
MAIN_UNIT="fatcat-bot.service"
BACKUP_UNIT="fatcat-backup.service"
BACKUP_TIMER="fatcat-backup.timer"

info() { printf '\033[36m[info]\033[0m %s\n' "$*"; }
ok()   { printf '\033[32m[ ok ]\033[0m %s\n' "$*"; }
warn() { printf '\033[33m[warn]\033[0m %s\n' "$*"; }
die()  { printf '\033[31m[fail]\033[0m %s\n' "$*" >&2; exit 1; }

# 打印文件头部那段注释作为帮助（从第 2 行起，遇到第一行非注释就停）
usage() {
  awk 'NR>1 { if (/^#/) { sub(/^# ?/, ""); print } else { exit } }' "${BASH_SOURCE[0]}"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --dir)          APP_DIR="${2:-}"; shift 2 ;;
    --user)         RUN_USER="${2:-}"; shift 2 ;;
    --group)        RUN_GROUP="${2:-}"; shift 2 ;;
    --node)         NODE_BIN="${2:-}"; shift 2 ;;
    --backup-dir)   BACKUP_DIR="${2:-}"; shift 2 ;;
    --no-backup-timer) WITH_BACKUP=0; shift ;;
    --dry-run)      DRY_RUN=1; shift ;;
    -h|--help)      usage; exit 0 ;;
    *)              die "未知参数：$1（用 --help 看用法）" ;;
  esac
done

[ -n "$APP_DIR" ] || APP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
APP_DIR="$(cd "$APP_DIR" && pwd)"
[ -f "$APP_DIR/src/index.js" ] || die "这里不像是项目根目录（找不到 src/index.js）：$APP_DIR"
[ -n "$BACKUP_DIR" ] || BACKUP_DIR="$APP_DIR/backups"

# ---------- 1. Node 版本 ----------
if [ -z "$NODE_BIN" ]; then
  NODE_BIN="$(command -v node || true)"
fi
[ -n "$NODE_BIN" ] || die "PATH 里找不到 node。装了的话用 --node /usr/bin/node 指定绝对路径"
NODE_BIN="$(cd "$(dirname "$NODE_BIN")" && pwd)/$(basename "$NODE_BIN")"

NODE_VER="$("$NODE_BIN" -p 'process.versions.node' 2>/dev/null || true)"
[ -n "$NODE_VER" ] || die "无法执行 $NODE_BIN"
NODE_MAJOR="${NODE_VER%%.*}"
NODE_REST="${NODE_VER#*.}"
NODE_MINOR="${NODE_REST%%.*}"
if [ "$NODE_MAJOR" -lt 22 ] || { [ "$NODE_MAJOR" -eq 22 ] && [ "$NODE_MINOR" -lt 5 ]; }; then
  die "Node 版本过低：$NODE_VER（需要 >= 22.5.0，node:sqlite 从 22.5 才有）"
fi
ok "Node $NODE_VER（$NODE_BIN）"

# ---------- 2. 权限与账号 ----------
if [ "$DRY_RUN" -eq 0 ]; then
  [ "$(id -u)" -eq 0 ] || die "需要 root 权限。请用：sudo bash deploy/install-systemd.sh"
  command -v systemctl >/dev/null 2>&1 || die "这台机器上没有 systemctl，请改用 Docker 部署（见 deploy/README.md）"
fi

if [ "$DRY_RUN" -eq 0 ] && ! id -u "$RUN_USER" >/dev/null 2>&1; then
  info "创建系统账号 $RUN_USER"
  if command -v useradd >/dev/null 2>&1; then
    useradd --system --home-dir "$APP_DIR" --shell /usr/sbin/nologin "$RUN_USER" \
      || die "创建账号失败，可改用 --user <已有账号>"
  else
    die "没有 useradd，请手动建账号后 --user 指定"
  fi
fi

if [ "$DRY_RUN" -eq 0 ] && id -u "$RUN_USER" >/dev/null 2>&1; then
  [ -n "$RUN_GROUP" ] || RUN_GROUP="$(id -gn "$RUN_USER")"
fi
[ -n "$RUN_GROUP" ] || RUN_GROUP="$RUN_USER"

# ---------- 3. 数据目录 ----------
if [ "$DRY_RUN" -eq 0 ]; then
  mkdir -p "$APP_DIR/data" "$BACKUP_DIR"
  chown -R "$RUN_USER:$RUN_GROUP" "$APP_DIR/data" "$BACKUP_DIR"
  chmod 700 "$APP_DIR/data" "$BACKUP_DIR"
  ok "数据目录就绪：$APP_DIR/data"
  ok "备份目录就绪：$BACKUP_DIR"
fi

[ -f "$APP_DIR/.env" ] || warn "还没建 .env，启动后会走默认配置（连 ws://127.0.0.1:3001）。建议先 cp .env.example .env"

# ---------- 4. 渲染单元 ----------
# ProtectHome：项目装在 /home 或 /root 下时，ProtectHome=true 会让服务读不到自己的代码，
# 所以那种情况退一档用 read-only。
case "$APP_DIR" in
  /home/*|/root/*|/root) PROTECT_HOME="read-only" ;;
  *)                     PROTECT_HOME="true" ;;
esac

sed_escape() { printf '%s' "$1" | sed -e 's/[\\&|]/\\&/g'; }

render() {
  local src="$1"
  [ -f "$src" ] || die "缺少模板文件：$src"
  sed \
    -e "s|@APP_DIR@|$(sed_escape "$APP_DIR")|g" \
    -e "s|@BACKUP_DIR@|$(sed_escape "$BACKUP_DIR")|g" \
    -e "s|@RUN_USER@|$(sed_escape "$RUN_USER")|g" \
    -e "s|@RUN_GROUP@|$(sed_escape "$RUN_GROUP")|g" \
    -e "s|@NODE_BIN@|$(sed_escape "$NODE_BIN")|g" \
    -e "s|@PROTECT_HOME@|$(sed_escape "$PROTECT_HOME")|g" \
    "$src"
}

install_unit() {
  local src="$1" name="$2"
  local body
  body="$(render "$src")"
  if printf '%s' "$body" | grep -q '@[A-Z_]*@'; then
    die "$name 里还有没替换掉的占位符，模板和脚本对不上了"
  fi
  if [ "$DRY_RUN" -eq 1 ]; then
    printf '\n===== %s =====\n%s\n' "$UNIT_DIR/$name" "$body"
    return
  fi
  printf '%s\n' "$body" > "$UNIT_DIR/$name"
  chmod 644 "$UNIT_DIR/$name"
  ok "已安装 $UNIT_DIR/$name"
}

info "项目目录：$APP_DIR"
info "运行账号：$RUN_USER:$RUN_GROUP"
info "ProtectHome=$PROTECT_HOME"

install_unit "$SCRIPT_DIR/$MAIN_UNIT" "$MAIN_UNIT"
if [ "$WITH_BACKUP" -eq 1 ]; then
  install_unit "$SCRIPT_DIR/$BACKUP_UNIT" "$BACKUP_UNIT"
  install_unit "$SCRIPT_DIR/$BACKUP_TIMER" "$BACKUP_TIMER"
fi

# ---------- 5. 启动 ----------
if [ "$DRY_RUN" -eq 1 ]; then
  printf '\n===== 接下来会执行 =====\n'
  printf 'systemctl daemon-reload\n'
  printf 'systemctl enable --now %s\n' "$MAIN_UNIT"
  [ "$WITH_BACKUP" -eq 1 ] && printf 'systemctl enable --now %s\n' "$BACKUP_TIMER"
  printf '\n（--dry-run，什么都没真的改）\n'
  exit 0
fi

systemctl daemon-reload
systemctl enable --now "$MAIN_UNIT"
if [ "$WITH_BACKUP" -eq 1 ]; then
  systemctl enable --now "$BACKUP_TIMER"
fi

sleep 2
printf '\n'
systemctl --no-pager --full status "$MAIN_UNIT" | head -n 14 || true
if [ "$WITH_BACKUP" -eq 1 ]; then
  printf '\n'
  systemctl --no-pager list-timers "$BACKUP_TIMER" || true
fi

cat <<'EOF'

—— 常用命令 ——
  看日志      journalctl -u fatcat-bot -f
  看最近日志  journalctl -u fatcat-bot -n 100 --no-pager
  重启        systemctl restart fatcat-bot
  停止        systemctl stop fatcat-bot
  看失败单元  systemctl --failed
  手动备份    systemctl start fatcat-backup.service
  恢复数据    systemctl stop fatcat-bot
              cp -a <备份目录>/latest/fatcat.db <项目目录>/data/fatcat.db
              rm -f <项目目录>/data/fatcat.db-wal <项目目录>/data/fatcat.db-shm
              chown fatcat:fatcat <项目目录>/data/fatcat.db
              systemctl start fatcat-bot

—— 还没做的一步 ——
  管理台默认只监听 127.0.0.1，从外网连不上。要远程访问请按 deploy/README.md
  配 SSH 隧道或反向代理（管理台本身不带 HTTPS，别直接暴露公网）。

EOF
