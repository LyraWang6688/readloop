# 部署与技术环境

> 状态：当前有效
> 最近更新：2026-10-23
> 数据来源：[我的项目与部署台账](https://my.feishu.cn/base/NeujbbOfcaPEvMsPIxscaJImn9d?table=tblgTMnvrNSSOLsD)（2026-10-19 体检）
> 上位文档：[ARCHITECTURE.md](./ARCHITECTURE.md)

---

## 一、服务器

单台腾讯云服务器：**43.143.239.42**，所有项目共用。

| 项目 | 状态 | 端口 | 运行方式 | 域名 |
|---|---|---|---|---|
| 会议分析系统 | 🟢 运行中 | 3011 | Docker | meeting.bamamei.online |
| box2bitable | 🟢 运行中 | 5000 | pm2 | api / hm.bamamei.online |
| 阅读分析 Web 应用（ReadInsight） | ⚫ 2026-10-04 已删除 | 3000 | Docker | readinsight.bamamei.online |
| 服务器状态扫描器 | ⚫ 已删除 | 8765 | pm2 | scanner.bamamei.online |
| 飞书 CLI MCP 服务 | ⚫ 已删除 | 3100 | pm2 | feishu-mcp.bamamei.online |
| 微信文章草稿生成 | ⚫ 已删除 | 3010 | pm2 | draft-api.bamamei.online |

**ReadInsight 的旧部署已被完整清理**：容器停止、`/opt/readinsight` 删除、Nginx 站点摘除、镜像清理。
所以 `readinsight.bamamei.online` 打不开不是故障，是主动下线。**端口 3000 现在空闲。**

---

## 二、ReadLoop 的部署方案

| 项 | 选择 |
|---|---|
| 方式 | Docker（与会议分析系统一致） |
| 目录 | `/opt/readloop` |
| 端口 | 3000 |
| 域名 | `readinsight.bamamei.online`（DNS 仍指向本机） |
| 反代 | Nginx → `127.0.0.1:3000` |
| 证书 | 需**新签**（现有证书只覆盖 `api.bamamei.online`，单域名） |

### 部署步骤

```bash
# 1. 上传代码并构建
cd /opt/readloop
docker compose up -d --build

# 2. Nginx 站点
#    /etc/nginx/sites-available/readloop  → proxy_pass http://127.0.0.1:3000
#    ln -s 到 sites-enabled && nginx -t && systemctl reload nginx

# 3. 证书
certbot --nginx -d readinsight.bamamei.online

# 4. 验证
curl -I https://readinsight.bamamei.online
```

---

## 三、部署前必须解决的四个卡点

| # | 卡点 | 影响 | 解法 |
|---|---|---|---|
| 1 | ~~GitHub 仓库已归档~~ **已解决**（2026-10-23 取消归档） | — | — |
| 2 | **证书只覆盖单域名** | 新域名没有 HTTPS | certbot 重新签发 |
| 3 | **模型凭证** | 原 `coze-coding-dev-sdk` 依赖扣子沙箱内网，搬到腾讯云不可用 | **已定：DeepSeek**，用环境变量 `LLM_PROVIDER` / `LLM_MODEL` / `LLM_API_KEY` 配置 |
| 4 | 服务器操作权限 | 无法直接部署 | 提供 SSH 或由用户执行命令 |

---

## 四、本地开发

| 环境 | 说明 |
|---|---|
| 本地 | 服务可完全本地跑，只依赖模型 API key |
| 数据 | 不依赖数据库：表格在用户飞书里，服务无状态 |
| 调试 | Skill 可直接指向 `http://127.0.0.1:3000` |

**不再需要 `DATABASE_URL`。** 原有 PostgreSQL + Drizzle 仅作为历史实现保留，不再是运行必需项。
