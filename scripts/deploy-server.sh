#!/usr/bin/env bash
#
# 把当前工作区发布到服务器（源码同步 + 重新构建 + 健康检查）。
#
# 用法：
#   bash scripts/deploy-server.sh
#   DEPLOY_HOST=ubuntu@1.2.3.4 bash scripts/deploy-server.sh
#
# 为什么不用 git pull：
#   服务器直连 github.com 的 HTTPS 经常超时（实测 clone 130s 超时），所以用
#   「本地 tar 流 → SSH」同步源码；服务器上的 .env 与日志不会被覆盖。
#
# 前置：本机已配置到服务器的 SSH 免密登录；服务器已部署过一次（/opt/readloop 存在）。

set -euo pipefail

cd "$(dirname "$0")/.."

DEPLOY_HOST="${DEPLOY_HOST:-ubuntu@43.143.239.42}"
DEPLOY_DIR="${DEPLOY_DIR:-/opt/readloop}"
HEALTH_URL="${HEALTH_URL:-https://readinsight.bamamei.online/api/health}"
TAR_EXCLUDES=(
  --exclude='.git'
  --exclude='node_modules'
  --exclude='.next'
  --exclude='.pnpm-store'
  --exclude='.env'
  --exclude='.env.local'
  --exclude='.coze-logs'
  --exclude='*.tsbuildinfo'
  --exclude='.DS_Store'
  --exclude='HANDOFF.md'
  --exclude='assets'
)

echo "==> 同步源码到 ${DEPLOY_HOST}:${DEPLOY_DIR}"
ssh -o BatchMode=yes "$DEPLOY_HOST" "mkdir -p '$DEPLOY_DIR'"
COPYFILE_DISABLE=1 tar czf - "${TAR_EXCLUDES[@]}" . \
  | ssh -o BatchMode=yes "$DEPLOY_HOST" "tar xzf - -C '$DEPLOY_DIR'"

echo "==> 服务器上重新构建并启动（单副本）"
ssh -o BatchMode=yes "$DEPLOY_HOST" "cd '$DEPLOY_DIR' && docker compose up -d --build 2>&1 | tail -5"

echo "==> 等待健康检查通过：$HEALTH_URL"
for _ in $(seq 1 60); do
  if curl -fsS --max-time 5 "$HEALTH_URL" | grep -q '"status":"ok"'; then
    echo "✅ 部署完成"
    curl -fsS --max-time 5 "$HEALTH_URL"
    echo
    exit 0
  fi
  sleep 2
done

echo "❌ 健康检查未通过，查看服务器日志："
ssh -o BatchMode=yes "$DEPLOY_HOST" "cd '$DEPLOY_DIR' && docker compose logs --tail=50 readloop"
exit 1
