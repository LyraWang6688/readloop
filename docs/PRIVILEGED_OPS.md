# 越权磁盘操作记录（Store 仓库与权限升级）

> 本文记录**所有超出会话工作区**（`/Users/wangying/Documents/workplace/ReadLoop`）的本地磁盘写操作，
> 以及为了完成这些操作而触发的 DSH 权限升级（`danger-full-access`）。
> 目的：可审计、可复现、可清理；也说明为什么这些操作必须发生在 ReadLoop 仓库之外。
>
> 时间范围：2026-10-23 ~ 2026-10-24。记录人：Agent（Lead）。

## 一、权限模型（为什么会有「授权全部磁盘」）

- DSH 默认文件策略是 **workspace-write**：只能写会话工作区 `ReadLoop/`。
- 写工作区外路径时被拦截，报 `[sandbox: file access denied under workspace-write mode]`；
  于是发起**一次性**权限升级（`danger-full-access`），弹窗由用户确认，`justification` 写明路径与目的。
- 审批策略为 **ask**：不确认就不执行；拒绝则 fail closed。
- 规则：**只升到够用的最小范围、只在必要的一次命令里使用、不留后台任务。**

## 二、为什么必须写工作区外

ReadLoop 的技能包（`skills/readloop`）**不在本仓库**，在独立的 Store 仓库：

```
/Users/wangying/Documents/workplace/ai-capability-store
```

同步接口文档 / 版本号 / 打 tag 都必须改这个仓库。为了不碰用户/其它会话正在用的 checkout，
统一做法是：**从 `origin/main` 建 git worktree → 在 worktree 里改 → PR → 合并 → 打 tag → 删除 worktree**。

| 路径 | 用途 | 是否属于本仓库 |
|---|---|---|
| `/Users/wangying/Documents/workplace/ReadLoop` | 服务代码（会话工作区） | ✅ 默认可写 |
| `/Users/wangying/Documents/workplace/ai-capability-store` | Store 主 checkout（**不直接改**） | ❌ 需升级 |
| `/Users/wangying/Documents/workplace/readloop-*-wt` | 临时 worktree（改完即删） | ❌ 需升级 |
| `/tmp/*` | 临时脚本/缓存/密钥文件（应清理） | ⚠️ 平台临时区 |

## 三、操作清单

### 3.1 Store 主仓库同步（只读拉取）

| 项 | 内容 |
|---|---|
| 时间 | 2026-10-23 |
| 命令 | `git -C <store> pull --ff-only origin main` |
| 为什么升级 | `pull` 会写 `<store>/.git`（对象/引用），在主 checkout 上无法避免 |
| 结果 | 成功；本地 Store `main` 更新到当时远端 HEAD（`8a2ecc1`） |
| 备注 | 后续其它会话把 Store main 推进到 `22080a1`；本次未再动主 checkout |

### 3.2 PR #302：readloop 文档核对（8 处修正 + `readloop 0.2.3`）

| 项 | 内容 |
|---|---|
| worktree | `/Users/wangying/Documents/workplace/readloop-docs-audit-wt`，分支 `fix/readloop-docs-audit`（基于 `origin/main`） |
| 升级操作 | `git fetch` / `git worktree add` / `python3` 改文件 / `git commit` / `git push` / `git tag` / `git worktree remove` |
| 改动 | `skills/readloop/` 下的 SKILL / README / references（插件安装、模型说法、错误码、curl 鉴权、字段必填性、豆包检查项等 8 处修正）；`skills/registry.yaml`（0.2.2 → 0.2.3） |
| 校验 | `python3 scripts/validate_store.py`（1713 checks，0 failures）、`npx skills-ref validate skills/readloop`（Valid） |
| 结果 | PR #302 合并；tag `readloop-v0.2.3` 已推送到 GitHub |
| 清理 | worktree 删除、分支 `fix/readloop-docs-audit` 删除 |

### 3.3 PR #305：指标接口契约同步（`readloop 0.2.4` / `readloop-service 0.2.2`）

| 项 | 内容 |
|---|---|
| worktree | `/Users/wangying/Documents/workplace/readloop-metrics-wt`，分支 `feat/readloop-metrics-0.2.4` |
| 升级操作 | 同上（worktree 创建、文件写入、commit/push、tag、清理） |
| 改动 | `references/api.md`（新增 `/api/review/metrics`，`today` 加 `performance`/`difficulty`，初始化章节 4→5）、`references/schema.md`（`practice_events.复习间隔`）、`SKILL.md`（日常 2/4 + 每周复盘）、`skills/registry.yaml`（0.2.4）、`external-capabilities/registry.yaml`（0.2.2） |
| 校验 | validate_store 1713/0、skills-ref Valid |
| 结果 | PR #305 合并；tag `readloop-v0.2.4`、`readloop-service-v0.2.2` |
| 清理 | worktree / 分支已删 |

### 3.4 PR #306：规则评估结论同步（`readloop-service 0.2.3`）

| 项 | 内容 |
|---|---|
| worktree | `/Users/wangying/Documents/workplace/readloop-eval-wt`，分支 `feat/readloop-eval-note` |
| 升级操作 | 同上 |
| 改动 | `external-capabilities/registry.yaml`：版本 0.2.2 → 0.2.3，notes 追加 SM-2 vs FSRS 回放结论与「暂不切换」决策 |
| 校验 | validate_store 1713/0、skills-ref Valid |
| 结果 | PR #306 合并；tag `readloop-service-v0.2.3` |
| 清理 | worktree / 分支已删 |

### 3.5 失败的尝试（已记录，避免重犯）

| 尝试 | 报错 | 处理 |
|---|---|---|
| `git fetch origin main:main`（想把远端 main 同步进本地 main） | `refusing to fetch into branch 'refs/heads/main' checked out at ...` | 放弃改主分支；改为直接从 `origin/main` 建 worktree / 打 tag |
| `check_tag_version.py --missing main` 偶发 | `origin/main is not reachable from main` | 本地 `main` 引用落后时的误报；改用 `--missing origin/main` 复核，tag 指向已合并的 `origin/main` 提交 |
| `pnpm add -D ts-fsrs`（装在 ReadLoop 内） | 网络超时（未成功、未污染依赖） | 改为内置 `src/lib/fsrs-lite.ts` 实现，不增依赖 |

### 3.6 `/tmp` 临时文件（非升级，但一并登记）

| 文件 | 用途 | 状态 |
|---|---|---|
| `/tmp/readloop-secrets.env` | 部署脚本读取的生产密钥（临时） | 已删除 |
| `/tmp/readloop-ext-release-notes.md` | GitHub Release 说明稿 | 已用后丢弃 |
| `/tmp/readloop-npm-cache/` | `npx skills-ref` 缓存（避免 home 目录 EPERM） | 可留存，可随时删 |
| `/tmp/dl.zip`、`/tmp/anki.html` 等 | 发布包校验 / 文档抓取 | 已清理或可随时删 |

> **没有**写入 `~/`、`/opt`、其它项目目录；**没有**把任何密钥写进 Store 仓库或 worktree。
> 服务器（`/opt/readloop`、Nginx、Docker）通过 SSH 在远端操作，不属于本机磁盘授权范围。

## 四、安全边界（这些事没做）

- ❌ 没有直接改 Store 主 checkout 的工作区（只 `pull` 过 `.git`）
- ❌ 没有切换/覆盖其它会话的 worktree（如 `.dsh-wt-skill2`，全程未碰）
- ❌ 没有 `git push --force`；没有改 `main` 历史
- ❌ 没有把 `api_key` / `app_secret` / 完整 `host_token` 写进 Store 或本仓库
- ❌ 没有在 `/tmp` 长期保留密钥（用后即删）
- ✅ 分支只删自己创建的功能分支；tag 只在合并后打

## 五、现状核对（只读命令）

```bash
# 1) 没有遗留的 readloop worktree
ls -d /Users/wangying/Documents/workplace/readloop-*-wt 2>/dev/null || echo "无遗留"

# 2) Store worktree 只剩主 checkout（+ 其它会话自己的）
git -C /Users/wangying/Documents/workplace/ai-capability-store worktree list

# 3) Store 主 checkout 干净、在 main
git -C /Users/wangying/Documents/workplace/ai-capability-store status --short
git -C /Users/wangying/Documents/workplace/ai-capability-store branch --show-current

# 4) 本仓库干净
cd /Users/wangying/Documents/workplace/ReadLoop && git status --short && git log --oneline -1

# 5) 远端 tag 存在（gh 已认证时）
for t in readloop-v0.2.3 readloop-v0.2.4 readloop-service-v0.2.2 readloop-service-v0.2.3; do
  gh api "repos/LyraWang6688/ai-capability-store/git/ref/tags/$t" --jq '.object.sha' || echo "$t missing"
done

# 6) HANDOFF 未被跟踪（G07）
git ls-files | grep -i handoff || echo "OK：没有 handoff 进库"
```

**2026-10-24 核对结果**：无遗留 worktree；Store 主 checkout 在 `main` 且干净（记录时 `22080a1`；
Store 会被其它会话持续更新，当前值以核对命令为准）；ReadLoop 干净（`26a3dab`，文档提交后为 `391cd7e`）；
`/tmp/readloop-secrets.env` 已不存在；记录时 Store worktree 里另有其它会话的 `.dsh-wt-skill2`，
本次未触碰，随后已被其创建者清理。

## 六、今后规则

1. 改 Store：**一律 worktree**，从 `origin/main` 建；不碰主 checkout 的工作区/当前分支。
2. 每次升级写清 `justification`：目标路径 + 目的 + 范围；能用一条命令就不拆多条。
3. 密钥只在 `ReadLoop/.env`（gitignore）或 `/tmp` 临时文件；结束即删，绝不进 Store。
4. 合并后再打 tag；tag 前用 `check_tag_version.py --missing origin/main` 复核。
5. 收尾必须：删 worktree、删功能分支、核对 `git status`；遗留即视为事故。
6. 本文只记录**本机**磁盘操作；远端服务器操作见 `docs/DEPLOYMENT.md`。
