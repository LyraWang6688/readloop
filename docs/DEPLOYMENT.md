# 部署与技术环境

> 状态：**已上线**（2026-10-23）：<https://readinsight.bamamei.online>
> 最近更新：2026-10-23
> 数据来源：[我的项目与部署台账](https://my.feishu.cn/base/NeujbbOfcaPEvMsPIxscaJImn9d?table=tblgTMnvrNSSOLsD)（2026-10-19 体检）
> 上位文档：[ARCHITECTURE.md](./ARCHITECTURE.md)、[API_IMPLEMENTATION.md](./API_IMPLEMENTATION.md)

---

## 〇、线上现状（2026-10-23 实测）

| 项 | 值 |
|---|---|
| 域名 | `https://readinsight.bamamei.online`（HTTP 301 → HTTPS） |
| 容器 | `readloop-service`（Docker，`restart: unless-stopped`，单副本） |
| 监听 | `127.0.0.1:3000`（只对 Nginx 暴露） |
| Nginx | `/etc/nginx/sites-available/readloop` → `proxy_pass 127.0.0.1:3000` |
| 证书 | Let's Encrypt，`readinsight.bamamei.online`，到期 2027-01-21；自动续期已就绪（`renew --dry-run` 通过） |
| 目录 | `/opt/readloop`（源码 + `.env`，`.env` 权限 600） |
| 验证 | `GET /api/health` → `{"status":"ok"}`；远程接口冒烟 54 项全过（`scripts/smoke-api.ts`） |
| 兼容性 | 同机其它站点（meeting / api / hm）未受影响 |

**更新发布**（改完代码后一条命令）：

```bash
bash scripts/deploy-server.sh
```

流程：本地必须 commit 干净 → `git push origin main` → 服务器 `/opt/readloop` 执行 `git pull --ff-only`
→ 校验服务器 HEAD 与本机一致 → `docker compose up -d --build` → 轮询 `/api/health` 直到通过。

- `/opt/readloop` 就是 GitHub 的 **git clone**（`origin = https://github.com/LyraWang6688/readloop.git`），
  服务器上可以直接 `git log` / `git diff` 核对版本。
- 服务器直连 GitHub 偶发超时；脚本里 `git pull` 失败会自动改用镜像
  `https://ghfast.top/https://github.com/...`（已配为 `mirror` remote），再失败才报错退出。
- 已经 push 过、只想重建时：`bash scripts/deploy-server.sh --skip-push`。

> **Docker Hub 拉取慢**：首次构建从 Docker Hub 拉 `node:22-bookworm-slim` 只有 ~0.4MB/s。
> 解决：从国内镜像源拉一次再打 tag（`docker pull docker.1ms.run/library/node:22-bookworm-slim` +
> `docker tag … node:22-bookworm-slim`），或在服务器 `.env` 里设
> `NODE_IMAGE=docker.1ms.run/library/node:22-bookworm-slim`（compose 会作为 build-arg 传进去）。
> Dockerfile 里 `npm i -g pnpm` 已固定走 npmmirror。

---

## 一、服务器

单台腾讯云服务器：**43.143.239.42**，所有项目共用。

| 项目 | 状态 | 端口 | 运行方式 | 域名 |
|---|---|---|---|---|
| 会议分析系统 | 🟢 运行中 | 3011 | Docker | meeting.bamamei.online |
| box2bitable | 🟢 运行中 | 5000 | pm2 | api / hm.bamamei.online |
| ReadLoop | 🟢 运行中（2026-10-23 上线） | 3000 | Docker | readinsight.bamamei.online |
| 阅读分析 Web 应用（旧 ReadInsight） | ⚫ 2026-10-04 已删除 | 3000 | Docker | readinsight.bamamei.online |

**旧部署已被完整清理**：容器停止、`/opt/readinsight` 删除、Nginx 站点摘除、镜像清理。
所以历史上 `readinsight.bamamei.online` 打不开不是故障，是主动下线。**端口 3000 现由 ReadLoop 使用。**

---

## 二、部署方案

| 项 | 选择 |
|---|---|
| 方式 | Docker（`Dockerfile` 多阶段，Next.js `output: "standalone"`） |
| 目录 | `/opt/readloop` |
| 端口 | 3000（只绑 `127.0.0.1`，由 Nginx 反代） |
| 域名 | `readinsight.bamamei.online`（DNS 仍指向本机） |
| 反代 | Nginx → `127.0.0.1:3000` |
| 证书 | 需**新签**（现有证书只覆盖 `api.bamamei.online`，单域名） |
| 副本数 | **只能 1 个**（见下方「单实例约束」） |

### 单实例约束（重要）

`/api/setup/app/*` 的创建会话（含一次性 app_secret、配对码）存在**进程内存**里
（`src/lib/feishu/session-store.ts` 挂在 `globalThis`），因此：

- 不要 `docker compose up --scale readloop=2`，也不要挂多台后端
- 不适合部署到 serverless / 多副本平台
- 进程重启会丢「未完成的一键创建」会话——用户重新点一次链接即可，**不影响已激活的 host_token**

### 环境变量（`/opt/readloop/.env`）

| 变量 | 必填 | 说明 |
|---|---|---|
| `LICENSE_SECRET` | ✅ | 授权码校验位 + `host_token` 签名。**必须换成随机长串**；轮换 = 所有旧授权码失效 |
| `QUESTION_ID_SECRET` | ✅ | `question_id` 签名。**必须换成随机长串** |
| `PORT` | — | 容器内固定 3000（compose 已设） |
| `FEISHU_INITIATOR_APP_ID` / `_SECRET` | — | 仅留档；`registerApp` 走飞书公开注册端点，缺了也能用 |
| `READLOOP_QUESTION_LLM` | — | 留空/0 = 题面走确定性模板（MVP 默认）；=1 才启用 LLM 润色 |

**服务器不需要任何模型 API Key**：模型配置由用户随请求带上（BYOK）。

生成两个密钥：

```bash
openssl rand -hex 32   # LICENSE_SECRET
openssl rand -hex 32   # QUESTION_ID_SECRET
```

### 首次部署步骤（已完成，留档）

```bash
# 1. 服务器上准备目录
sudo mkdir -p /opt/readloop && sudo chown -R ubuntu:ubuntu /opt/readloop

# 2. 从 GitHub 克隆（仓库是 public，服务器可直接 HTTPS clone）
sudo mkdir -p /opt/readloop && sudo chown ubuntu:ubuntu /opt/readloop
git clone https://github.com/LyraWang6688/readloop.git /opt/readloop

# 2.1 配镜像兜底（直连 GitHub 偶发超时）
cd /opt/readloop
git remote add mirror https://ghfast.top/https://github.com/LyraWang6688/readloop.git
git config pull.ff only

# 3. 写环境变量（服务器上；LICENSE_SECRET / QUESTION_ID_SECRET 用 openssl rand -hex 32 生成）
cd /opt/readloop && vim .env && chmod 600 .env

# 4. 构建并启动（单副本）
docker compose up -d --build

# 5. Nginx 站点：/etc/nginx/sites-available/readloop（见下），enable 后 reload
sudo nginx -t && sudo systemctl reload nginx

# 6. 证书
sudo certbot --nginx -d readinsight.bamamei.online --non-interactive --agree-tos --redirect

# 7. 验证
curl -s https://readinsight.bamamei.online/api/health
```

Nginx 站点内容（`/etc/nginx/sites-available/readloop`）：

```nginx
server {
    # ReadLoop 后端服务（Docker readloop-service，Next.js standalone，127.0.0.1:3000）
    # 调用方是 Chrome 插件与 AI 宿主（任意 IP），不做白名单；靠 host_token 鉴权。
    server_name readinsight.bamamei.online;

    client_max_body_size 2m;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 120s;
    }
}
```

日常发布：`bash scripts/deploy-server.sh`（push → 服务器 git pull → 重建 → 健康检查）。

## 三、部署前必须解决的卡点

| # | 卡点 | 影响 | 解法 |
|---|---|---|---|
| 1 | ~~GitHub 仓库已归档~~ **已解决**（2026-10-23 取消归档） | — | — |
| 2 | **证书只覆盖单域名** | 新域名没有 HTTPS | `certbot --nginx -d readinsight.bamamei.online` |
| 3 | ~~模型凭证~~ **已定：BYOK** | — | 服务端不需要模型 Key；用户随请求带 |
| 4 | 服务器操作权限 | 无法直接部署 | 提供 SSH 或由用户执行上面 5 步 |
| 5 | 真实飞书链路未验证 | 一键创建/三项校验只在代码与假接口上验证过 | 部署后用真实飞书账号跑一次「初始化 → 配对 → 插件入库」 |

---

## 四、本地开发

| 环境 | 说明 |
|---|---|
| 服务 | `pnpm dev`（默认 3000），需要 `.env` 里的两个签名密钥 |
| 数据 | 不依赖数据库：表格在用户飞书里，服务无状态 |
| 调试 | Skill 可直接指向 `http://127.0.0.1:3000` |
| 冒烟 | `bash scripts/smoke-api.sh`（起真实 `next start`，49 项断言，不调飞书/模型） |
| 构建 | `pnpm build`（`output: "standalone"`，产物在 `.next/standalone`） |

**不需要 `DATABASE_URL`。** 原有 PostgreSQL + Drizzle 已移除，`.env` 里的旧连接串与 `Supabase` 密码建议轮换后删除。

### 本地发授权码

```bash
LICENSE_SECRET=与服务器一致 npx tsx scripts/license-gen.ts 10
```

服务端不存码表（校验位由密钥派生），所以**发码必须用服务器同一个 `LICENSE_SECRET`**；
换密钥会让所有已发出的授权码失效（见 `docs/DECISIONS.md`）。
