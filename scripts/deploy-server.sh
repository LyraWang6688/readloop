#!/usr/bin/env bash
#
# 发布到生产：本地 push 到 GitHub → 服务器 git pull → Docker 重建 → 健康检查。
#
# 用法：
#   bash scripts/deploy-server.sh              # 默认：git push 后部署
#   bash scripts/deploy-server.sh --skip-push  # 已经 push 过，只让服务器拉取并重建
#   DEPLOY_HOST=ubuntu@1.2.3.4 bash scripts/deploy-server.sh
#
# 前置：
#   - 本机已配置到服务器的 SSH 免密登录
#   - 服务器 /opt/readloop 是 GitHub 的 git clone（origin 指向 readloop 仓库）
#   - 服务器能访问 GitHub；直连失败时自动改用 mirror（ghfast.top 代理）
#
# 注意：服务器是**单副本**（一键创建会话在进程内存里，见 docs/API_IMPLEMENTATION.md）。

set -euo pipefail

cd "$(dirname "$0")/.."

DEPLOY_HOST="${DEPLOY_HOST:-ubuntu@43.143.239.42}"
DEPLOY_DIR="${DEPLOY_DIR:-/opt/readloop}"
HEALTH_URL="${HEALTH_URL:-https://readinsight.bamamei.online/api/health}"
BRANCH="${DEPLOY_BRANCH:-main}"
MIRROR_URL="${GIT_MIRROR_URL:-https://ghfast.top/https://github.com/LyraWang6688/readloop.git}"

SKIP_PUSH=0
[[ "${1:-}" == "--skip-push" ]] && SKIP_PUSH=1

# ------------------------------------------------------------
echo "==> 检查工作区（必须提交干净，线上只认 git 里的版本）"
if [[ -n "$(git status --porcelain)" ]]; then
  echo "❌ 有未提交改动，先 commit："
  git status --short
  exit 1
fi

LOCAL_HEAD="$(git rev-parse HEAD)"

if [[ "$SKIP_PUSH" == "0" ]]; then
  echo "==> push 到 GitHub（origin/${BRANCH}）"
  git push origin "$BRANCH"
fi

# ------------------------------------------------------------
echo "==> 服务器 git pull"
ssh -o BatchMode=yes "$DEPLOY_HOST" bash -s <<REMOTE
set -e
cd '$DEPLOY_DIR'
echo "   pull 前: \$(git log --oneline -1)"
if git pull --ff-only origin '$BRANCH' 2>/dev/null; then
  echo "   直连 GitHub 拉取成功"
else
  echo "   直连失败，改用镜像: $MIRROR_URL"
  git fetch '$MIRROR_URL' '$BRANCH'
  git reset --hard FETCH_HEAD
fi
echo "   pull 后: \$(git log --oneline -1)"
REMOTE

REMOTE_HEAD="$(ssh -o BatchMode=yes "$DEPLOY_HOST" "cd '$DEPLOY_DIR' && git rev-parse HEAD")"
if [[ "$REMOTE_HEAD" != "$LOCAL_HEAD" ]]; then
  echo "❌ 服务器版本与本地 HEAD 不一致（本地 $LOCAL_HEAD / 服务器 $REMOTE_HEAD）"
  exit 1
fi
echo "✅ 服务器版本 = 本地 HEAD（${LOCAL_HEAD:0:7}）"

# ------------------------------------------------------------
echo "==> 服务器重新构建并启动（单副本）"
ssh -o BatchMode=yes "$DEPLOY_HOST" "cd '$DEPLOY_DIR' && docker compose up -d --build 2>&1 | tail -5"

# ------------------------------------------------------------
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
