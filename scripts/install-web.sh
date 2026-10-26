#!/usr/bin/env bash
# 把微信通道装进 web profile。会短暂停止 dsh-web.service（GUI 会话断开，重连即可）。
set -euo pipefail

DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
PROFILE_DIR="$DSH_HOME/profiles/web"
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVICE="${DSH_WEB_SERVICE:-dsh-web.service}"
BACKUP="$PROFILE_DIR/.weixin-backup-$(date +%Y%m%d-%H%M%S)"

log() { echo "[install-weixin] $*"; }

[ -f "$PROFILE_DIR/package.json" ] || { log "找不到 $PROFILE_DIR/package.json"; exit 1; }

mkdir -p "$BACKUP"
cp "$PROFILE_DIR/package.json" "$PROFILE_DIR/cordis.patch.yml" "$BACKUP"/
log "已备份到 $BACKUP"

rollback() {
  log "安装失败，回滚配置并尝试恢复服务"
  cp "$BACKUP/package.json" "$PROFILE_DIR/package.json" || true
  cp "$BACKUP/cordis.patch.yml" "$PROFILE_DIR/cordis.patch.yml" || true
  systemctl --user start "$SERVICE" || true
}
trap rollback ERR

if systemctl --user is-active --quiet "$SERVICE"; then
  log "停止 $SERVICE（当前 GUI 会话会断开）"
  systemctl --user stop "$SERVICE"
fi

node "$SRC/scripts/edit-profile.mjs" "$PROFILE_DIR" "$SRC"

log "pnpm install …"
if ! (cd "$PROFILE_DIR" && pnpm install --ignore-scripts); then
  log "pnpm install 失败，尝试使用临时 XDG_RUNTIME_DIR 重试"
  (cd "$PROFILE_DIR" && XDG_RUNTIME_DIR="$(mktemp -d)" pnpm install --ignore-scripts)
fi

log "校验 bundle 组合 …"
if ! dsh --profile web --dump-config 2>/dev/null | grep -q "weixin-channel"; then
  log "组合校验失败：weixin-channel 未出现"
  false
fi

trap - ERR
log "启动 $SERVICE"
systemctl --user start "$SERVICE"
sleep 2
systemctl --user is-active --quiet "$SERVICE" && log "服务已启动"

log "完成。下一步扫码登录："
log "  $PROFILE_DIR/node_modules/.bin/dsh-weixin-login"
log "然后重启：systemctl --user restart $SERVICE"
