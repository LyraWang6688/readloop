# ReadLoop 后端服务（Next.js 16，standalone 产物）
#
# 只跑一个 Node 进程：/api/setup/app/* 的创建会话存在进程内存里（见 docs/API_IMPLEMENTATION.md），
# 所以不能横向扩多副本，也不适合 serverless。单容器即可，重启会丢未完成的创建会话（可接受）。

# 基础镜像默认用 Docker Hub；国内服务器拉取慢时用 build-arg 换成镜像源，例如
#   docker compose build --build-arg NODE_IMAGE=docker.1ms.run/library/node:22-bookworm-slim
ARG NODE_IMAGE=node:22-bookworm-slim

FROM ${NODE_IMAGE} AS base

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"

RUN npm install -g pnpm@11.0.6 --registry=https://registry.npmmirror.com
WORKDIR /app

FROM base AS deps

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN pnpm install --frozen-lockfile

FROM deps AS builder

COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm exec next build

FROM ${NODE_IMAGE} AS runner

WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV HOSTNAME=0.0.0.0
ENV PORT=3000

# standalone 自带精简后的 node_modules 与 server.js；静态资源要单独拷
COPY --from=builder /app/public ./public
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static

EXPOSE 3000

CMD ["node", "server.js"]
