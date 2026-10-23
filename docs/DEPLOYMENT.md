# 部署与技术环境

> 状态：当前有效
> 最近更新：2026-10-23（接口与插件实现完成，部署待执行）
> 数据来源：[我的项目与部署台账](https://my.feishu.cn/base/NeujbbOfcaPEvMsPIxscaJImn9d?table=tblgTMnvrNSSOLsD)（2026-10-19 体检）
> 上位文档：[ARCHITECTURE.md](./ARCHITECTURE.md)、[API_IMPLEMENTATION.md](./API_IMPLEMENTATION.md)

---

## 一、服务器

单台腾讯云服务器：**43.143.239.42**，所有项目共用。

| 项目 | 状态 | 端口 | 运行方式 | 域名 |
|---|---|---|---|---|
| 会议分析系统 | 🟢 运行中 | 3011 | Docker | meeting.bamamei.online |
| box2bitable | 🟢 运行中 | 5000 | pm2 | api / hm.bamamei.online |
| ReadLoop | ⏳ 待部署 | 3000 | Docker | readinsight.bamamei.online |
| 阅读分析 Web 应用（旧 ReadInsight） | ⚫ 2026-10-04 已删除 | 3000 | Docker | readinsight.bamamei.online |

**旧部署已被完整清理**：容器停止、`/opt/readinsight` 删除、Nginx 站点摘除、镜像清理。
所以 `readinsight.bamamei.online` 打不开不是故障，是主动下线。**端口 3000 现在空闲。**

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

### 部署步骤

```bash
# 0. 本地推代码后，服务器上
mkdir -p /opt/readloop && cd /opt/readloop
git clone git@github.com:LyraWang6688/readloop.git .

# 1. 写环境变量（见上表）
cp .env.example .env && vim .env

# 2. 构建并启动（Dockerfile 用 standalone 产物）
docker compose up -d --build
docker compose logs -f readloop

# 3. Nginx 站点：/etc/nginx/sites-available/readloop
#    server_name readinsight.bamamei.online;
#    location / { proxy_pass http://127.0.0.1:3000; proxy_set_header Host $host; }
#    ln -s /etc/nginx/sites-available/readloop /etc/nginx/sites-enabled/ && nginx -t && systemctl reload nginx

# 4. 证书（现有证书不含新域名，必须重新签）
certbot --nginx -d readinsight.bamamei.online

# 5. 验证
curl -s -X POST https://readinsight.bamamei.online/api/license/activate \
  -H 'Content-Type: application/json' -d '{"license":"AAAAAAAA"}'
# 期望：400/401 的业务错误（说明服务起来了、信封正确），不是 502/无法连接
```

> Dockerfile / docker-compose 已按 standalone 产物改写，但**本地沙箱没有 Docker，未实际构建验证**——
> 首次部署若构建失败，优先看 `pnpm install --frozen-lockfile` 与 `.next/standalone` 是否生成。

---

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
