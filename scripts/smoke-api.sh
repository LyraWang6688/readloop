#!/usr/bin/env bash
#
# 端到端接口冒烟：起一个真实的 `next start`，跑 scripts/smoke-api.ts，然后收摊。
#
# 用法：
#   bash scripts/smoke-api.sh
#
# 前置：已经 `pnpm build`（没有 .next/BUILD_ID 时脚本会先构建）。
# 不需要飞书凭证、不需要大模型 Key：只用假密钥走完授权/组题/判分链路。

set -euo pipefail

cd "$(dirname "$0")/.."

PORT="${SMOKE_PORT:-3107}"
BASE_URL="http://127.0.0.1:${PORT}"
export SMOKE_BASE_URL="$BASE_URL"
export LICENSE_SECRET="${SMOKE_LICENSE_SECRET:-smoke-license-secret-please-change}"
export QUESTION_ID_SECRET="${SMOKE_QUESTION_ID_SECRET:-smoke-question-secret-please-change}"

if [[ ! -f .next/BUILD_ID ]]; then
  echo "==> 没有构建产物，先构建"
  ./node_modules/.bin/next build
fi

echo "==> 启动服务（端口 ${PORT}）"
./node_modules/.bin/next start -p "$PORT" > /tmp/readloop-smoke-server.log 2>&1 &
SERVER_PID=$!

cleanup() {
  if kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

echo "==> 等待服务就绪"
READY=0
for _ in $(seq 1 60); do
  if curl -s -o /dev/null -X POST "$BASE_URL/api/license/activate" \
      -H 'Content-Type: application/json' -d '{"license":"AAAAAAAA"}'; then
    READY=1
    break
  fi
  sleep 0.5
done

if [[ "$READY" != "1" ]]; then
  echo "❌ 服务没起来，日志："
  tail -40 /tmp/readloop-smoke-server.log
  exit 1
fi

echo "==> 跑冒烟断言"
./node_modules/.bin/tsx scripts/smoke-api.ts

echo "==> 完成（服务日志 /tmp/readloop-smoke-server.log）"
