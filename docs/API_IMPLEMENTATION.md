# 接口实现规格（服务端）

> 状态：实现中（2026-10-23）
> 上位契约：Store 的 `skills/readloop/references/api.md`（对外）
> 本文件只写「服务端怎么实现」：签名格式、选题口径、题面构造、配对流程、幂等边界。
> 对外行为与 Store 文档冲突时，以 Store 文档为准；需要改契约时先改文档再加实现。

服务端**无数据库、无用户数据**：所有接口都是「拿着用户传上来的数据算一遍、返回结果」。
需要跨请求记住的东西只有两类，且都带 TTL：

| 需要记住的 | 存哪 | 生命周期 |
|---|---|---|
| 一键创建应用的会话（含一次性凭证） | 进程内 Map（`globalThis`） | 10–15 分钟，交付后立即删除 |
| 其它 | 不存 | —— |

> 单实例部署（Docker，见 `docs/DEPLOYMENT.md`）。进程重启会丢创建会话——可接受：
> 用户重新点一次链接即可，凭证不会丢在服务端。

---

## 一、通用约定

### 1.1 响应信封

沿用 `src/types/index.ts` 的 `ApiResponse`：

```json
{ "success": true, "data": { } }
{ "success": false, "error": { "code": "INVALID_PARAMS", "message": "……", "details": "可选" } }
```

工具函数在 `src/lib/http.ts`：`jsonOk` / `jsonError` / `readJsonBody` / `requireHost` / `requireSecret`。

### 1.2 鉴权

除以下两个端点外，所有接口要求 `Authorization: Bearer <host_token>`：

- `POST /api/license/activate`（用户还没 token）
- `GET /api/setup/app/pair?code=…`（Chrome 插件拿凭证，没有 host_token）

`requireHost()` 的判定顺序：缺 token → 401；签名/格式不对 → 401；到期 → 402；服务端没配 `LICENSE_SECRET` → 503。

`/api/diagnose`（插件调用）也走同一套 `requireHost()`：未激活的插件拿不到诊断结果，401/402 的文案由插件侧给出。

### 1.3 状态码

| 码 | 含义 |
|---|---|
| 400 | 参数缺失/格式错误（含 date、model 配置） |
| 401 | 授权码无效 / host_token 无效 |
| 402 | 年度授权到期（**数据不动，不要重装**） |
| 404 | 创建会话或配对码不存在/已用过 |
| 410 | 创建会话已过期 |
| 422 | `points` 为空或字段不全 |
| 500/503 | 服务异常/部署缺配置；宿主最多重试 2 次 |

### 1.4 秘密与日志

- 任何日志、错误信息、`details` 字段**不得出现** `api_key` / `app_secret` / 完整 `host_token`
- 需要排查时只打印前缀（如 `sk-…` 前 3 位）或哈希
- 服务端不落库任何凭证；`app_secret` 交付后从内存删除

---

## 二、签名（`src/lib/token.ts`）

三种令牌共用一个构造：`base64url(JSON) . base64url(HMAC-SHA256)`，密钥来自环境变量。

### 2.1 授权码（8 位）

- 字母表 `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`（32 个字符，去掉 0/O/1/I）
- 结构：**7 位随机 + 1 位校验位**，校验位 = `HMAC(LICENSE_SECRET, "license:" + 前7位)` 首字节 `% 32`
- 服务端**不存码表**：`isValidLicenseCode()` 现场算校验位即可判定「是不是我们发的」
- 发码 = 离线运行 `scripts/license-gen.ts`，一次生成一批

> 代价：没有吊销名单。要吊销就轮换 `LICENSE_SECRET`（所有旧码同时失效），MVP 可接受，
> 写进 `docs/DECISIONS.md`。

### 2.2 host_token（宿主身份）

```json
{ "v": 1, "lic": "ABCD2345", "iat": 1761223200000, "exp": 1792759200000 }
```

- `exp = iat + 365 天`（年度授权，非自动续费）
- 激活不做唯一性约束：同一个授权码可以反复激活，每次签发新 token，旧 token 不强制失效
- 对外返回 `expiresAt` 用 `formatExpiryIso()` → `2027-10-23T00:00:00+08:00`

### 2.3 question_id（题目签名）

```json
{
  "v": 1, "d": "2026-10-23",
  "k": "subsequent", "p": "subsequent",
  "t": "choice", "a": "subsequent",
  "o": ["subsequent", "subsequence", "substantial", "substitute"],
  "alt": [],
  "m": "随后的", "e": "形近词 subsequent/subsequence 易混",
  "src": "https://…",
  "s": { "st": "review", "iv": 3, "ea": 2.5, "sk": 1, "lp": 0, "nd": 2 },
  "exp": 1793001599999
}
```

要点：

- **答案与作答前的状态快照都在签名里**，客户端改不了 ⇒ 服务端无需存会话就能幂等判分与算新状态
- `o` 只对 `choice` 题存在（选项原文，按题面顺序）：这样宿主既可以直接回传选项原文，
  也可以回传字母 `A/B/C/D`（服务端按 `o` 映射），两种都得判对
- `exp` = 出题日 23:59:59.999（+08:00）再 +48 小时，跨天补答仍能判分
- 客户端**不得解析/修改/长期缓存**；`question_id` 不是 JWT，不要塞进表里
- 载荷控制在 1.5KB 内（不要把整句原句塞进去，只放 `src` 链接与必要的讲解字段）

---

## 三、POST /api/license/activate

请求：`{ "license": "ABCD2345" }`（允许带空格/连字符，服务端归一化）

| 情况 | 返回 |
|---|---|
| 缺字段/长度或字符不合法 | 400 `INVALID_PARAMS` |
| 校验位不对 | 401 `LICENSE_INVALID` |
| 通过 | 200 `{ hostToken, expiresAt }` |

实现要点：

- `normalizeLicenseCode` → `isValidLicenseCode`
- 签发用 `signHostToken(code, Date.now(), LICENSE_SECRET)`
- 只记一行 `console.info("license activated", { licensePrefix: code.slice(0,3), expiresAt })`
- 不做频率限制（MVP 单用户；加限制会误伤换机重试）

---

## 四、POST /api/review/today

请求：

```json
{
  "date": "2026-10-23",
  "model": { "provider": "deepseek", "base_url": "https://api.deepseek.com/v1", "model": "deepseek-chat", "api_key": "sk-…" },
  "points": [ { "知识点": "subsequent", "归一化内容": "subsequent", "类型": "word", "释义": "随后的", "状态": "review", "间隔天数": 3, "难度因子": 2.5, "连对次数": 1, "答错次数": 0, "待练次数": 2, "下次复习": "2026-10-23", "来源原句": "……" } ]
}
```

### 4.1 入场校验

1. `date` 缺失 → 用 `todayInShanghai()`；格式不对 → 400 `INVALID_PARAMS`
2. `model` → `normalizeModelConfig()`，失败 400 `MODEL_CONFIG_INVALID`
3. `points` 不是数组或为空 → 422 `POINTS_EMPTY`
4. 逐条校验必填：`归一化内容`（非空格）、`状态` ∈ {new, learning, review, relearning, mastered}；数字字段接受 number / 数字字符串，缺省用初始值 → 非法 422 `POINTS_INVALID`，`details` 指出第几条哪个字段

字段映射（表字段 → 内部）见 `references/schema.md`；内部类型放 `src/lib/selection.ts`：

```ts
interface ReviewPoint {
  id: string;              // 归一化内容（去重键）
  content: string;         // 知识点
  type: "word" | "phrase" | "pattern" | "comprehension_point";
  meaning: string;
  explanation?: string;
  example?: string;        // 来源原句
  state: "new" | "learning" | "review" | "relearning" | "mastered";
  intervalDays: number;
  ease: number;
  streak: number;
  lapses: number;
  need: number;
  nextReview?: string;     // YYYY-MM-DD
  lastSeen?: string;
  sourceUrl?: string;
}
```

`下次复习` 接受 `YYYY-MM-DD`、ISO 8601、毫秒时间戳三种写法（宿主读表格式不一），统一归一化到上海时区日期。

### 4.2 选题（确定性，纯函数 `selectDailyPoints`）

```
N = 8
active = points where state != "mastered"

① 到期：state ∈ {review, relearning} 且 nextReview ≤ date
       排序 (逾期天数 desc, need desc, id asc)，最多 5 题
② 新点：state == "new"，排序 (lastSeen desc, id asc)，最多 newQuota = 2
③ 补位：active 中未选中的，排序 (need desc, lapses desc, id asc)，补到 N 题
```

- 四类配额里的「重学补考」并入①（状态已经是 `relearning`；前一天答错的点 `nextReview` 就是次日）
- **新点配额是软上限**：③补位不排除 `new`，所以库小/新点多时新点题可能略多于 `newQuota`（`new_count` 仍按实际统计）
- 难题（lapses ≥ 4）：不单独排除，但在①③里排序靠前，且题面给提示（见 4.3）
- 全部归档/空库：返回 `questions: []`，`session_context` 里 `new_count=0, due_count=0, weak_points=[]`，宿主提示「去读一篇文章」
- 随机只用于**池内打散**，不用于改变选中集合：`seed = FNV1a(date + "|" + active.map(id).sort().join(","))`，
  `rng = mulberry32(seed)`；同样的输入与日期 ⇒ 同一批知识点、同一题型分配

### 4.3 题面构造（纯函数 `buildQuestions`，不依赖大模型）

> **MVP 决策**：题面由确定式模板生成（掩码原句 / 释义提示），LLM 润色默认关闭
> （`READLOOP_QUESTION_LLM=1` 时启用，失败自动回退）。理由：先跑通闭环，减少失败面；
> `model` 字段仍校验与接收，换模型不影响判分与选题。写进 `docs/DECISIONS.md`。

题型分配：严格交替 `choice` / `cloze`，起点由 `rng()` 决定；不足 3 个可用选项时该题强制 `cloze`。
（规则文档写「选择 40% / 输入式填空 40% / 短翻译 20%」，短翻译第二批才启用，MVP 在
启用题型内按 1:1 交替，等价于把 20% 摊进前两类。）

单题构造：

| 条件 | `cloze` 题面 | `choice` 题面 |
|---|---|---|
| 有 `来源原句` 且能在句中找到目标（忽略大小写） | 用 `____` 替换目标，`stem = 掩码句` | 同样掩码句 + 4 个选项 |
| 无原句 / 定位失败 | `stem = "中文：{释义}\n请写出对应的英文："` | `stem = "选出与「{释义}」对应的英文："` + 4 个选项 |

- 选项 = 正确答案 + 3 个干扰项（优先同 `类型` 的其它知识点，不足则跨类型补齐，仍不足则强制 `cloze`）；
  顺序由 `rng` 决定，正确答案位置不固定
- `hint`：`lapses ≥ 4` 时给「首字母 + 字母数」，否则 `null`
- 目标词不在句子里时**不要**让模型自由生成答案——答案永远是知识点本身（`a = 知识点`），
  `alt` 可放规范化前的其他写法（如复数）
- **`context` 当前恒为 `null`**：作答前返回未掩码原句等于送答案（宿主很可能直接把 context 渲染在题面旁）。
  语境由「掩码后的 `stem`」承担；`context` 字段保留给以后的**作答后**展示
- 输出题面**绝不含正确答案**；`question_id` 用 `signQuestionId()` 签名，内含答案与状态快照

### 4.4 返回

```json
{
  "date": "2026-10-23",
  "variant": 3,
  "total": 8,
  "answered": 0,
  "questions": [ { "question_id": "…", "type": "choice", "stem": "…", "options": ["…"], "context": null, "hint": null } ],
  "session_context": { "new_count": 2, "due_count": 5, "weak_points": ["the percentage of", "主谓一致"] }
}
```

- `variant = seed % 5`（0–4，界面变体）
- `session_context.new_count` / `due_count` = **本套题里**来自 new / 到期点的题数
- `weak_points` = 本套题来源点里 `(lapses desc, need desc)` 前 2 的 `知识点` 原文
- `answered` 恒为 0（服务端不记进度；宿主要显示进度就自己数 submit 次数）

---

## 五、POST /api/review/submit

请求：

```json
{ "date": "2026-10-23", "question_id": "…", "answer": "B", "used_hint": false, "elapsed_ms": 9000 }
```

`answer` 的统一口径：**选择题可以传选项原文，也可以传字母 `A/B/C/D`**（服务端按
`question_id` 里的 `o` 映射，两种都判对）；填空题传用户输入的原文。宿主不要做任何判分预处理。

实现：

1. `decodeQuestionId(question_id, QUESTION_ID_SECRET)` — 失败/过期 → 400 `QUESTION_INVALID`
2. 判分（**不调模型**）
   - `choice`：`answer` 规范化后是单字母 A–D 且 `payload.o` 存在 → 映射为 `payload.o[idx]` 再判；
     否则按选项原文判；`judgeChoice(expected, answer)`
   - `cloze` → `judgeCloze(expected, answer, alt)`；`answer` 是字母时直接判错，`explanation` 要提醒「请提交答案原文」
3. 档位：`toGrade(type, outcome, usedHint)`；另外「答对但 `elapsed_ms > 90_000`」也降为 `hard`
4. 新状态：`applyGrade(快照还原的 KnowledgeState, grade)`
5. `下次复习 = addDays(出题日期 d, max(间隔天数, 1))`（答错次日必出）
6. 返回：

```json
{
  "result": "correct",
  "grade": "good",
  "explanation": "正确答案：subsequent（随后的）。" ,
  "updates": {
    "知识点": "subsequent",
    "归一化内容": "subsequent",
    "状态": "review",
    "间隔天数": 6,
    "难度因子": 2.5,
    "连对次数": 2,
    "答错次数": 0,
    "待练次数": 1,
    "下次复习": "2026-10-29",
    "最近暴露": "2026-10-23"
  }
}
```

- `updates` 必须**包含 `难度因子`**（`ease` 会变，宿主不写回就会丢）
- `最近暴露` 取**出题日期 `d`**（不是服务器当前时间），这样同一 `question_id` 重复提交返回同一组 `updates`；
  代价是跨天补答时它显示的是出题日——幂等优先，写进 `docs/DECISIONS.md` 口径
- `result`：`correct` / `wrong`（Store 契约口径）
- 幂等：同一 `question_id` 重复提交返回**同一组 updates**（签名里是作答前快照，不会叠加计分）；
  宿主重复写入同样值无副作用
- 不返回 `answer` 以外的「标准答案对比」细节无关内容；`explanation` 只用 `释义` / `解释` / 判分原因拼装，
  拼装逻辑放 `src/lib/review.ts`，便于单测

---

## 六、POST /api/setup/app/start（一键创建用户飞书应用）

前置：`requireHost()` 通过。

请求：`{ "app_token": "bascn…" }`（必填，解析自用户的多维表格链接）

返回：`{ "session": "…", "verification_url": "https://…", "expires_at": "2026-10-23T22:10:00+08:00" }`

实现要点：

1. **不需要我们自己的应用凭证**：`@larksuiteoapi/node-sdk` 的 `registerApp()` 直接调用飞书公开的
   Device Grant 注册端点（`begin` → `poll`），用户点链接、在飞书点「同意」即可。环境变量
   `FEISHU_INITIATOR_APP_ID/SECRET` 仅作 `source` 标识与留档，**缺失不阻塞**
2. 调用参数（与参考实现 `teaming-bot` 一致）：

```ts
lark.registerApp({
  createOnly: true,
  source: "readloop",
  appPreset: { name: "ReadLoop 插件写入-{user}", desc: "ReadLoop Chrome 插件写表用，权限仅多维表格读写" },
  addons: {
    preset: false,
    scopes: { tenant: ["bitable:app", "base:field:update"] },
  },
  onQRCodeReady: (info) => { /* 存 verification_url + expireIn，resolve */ },
})
```

3. `onQRCodeReady` 回调前先建会话（状态 `starting`）；回调里置 `pending` 并保存 `verification_uri_complete`
4. 8 秒内没拿到链接 → 会话标 `failed`，接口返回 503 `SETUP_FAILED`
5. 注册 Promise 完成后：
   - 状态 `completed`，保存 `{app_id, app_secret}`
   - **立刻自己跑三项校验**（见 `src/lib/feishu/verify.ts`），把结果放 `checks`
   - 用新应用自己的凭证发布版本（`client.application.v7.applicationPublish.create`）——
     **不发布会话权限不生效**，这是手动流程里最容易漏的一步
6. 注册失败 → `failed` + 可读原因；用户取消（`access_denied`）要明说「已取消，可重新发起」

---

## 七、GET /api/setup/app/status?session=…

`requireHost()` 通过。返回：

```json
{ "status": "pending", "verification_url": "…", "expires_at": "…", "checks": null, "app_id": null, "app_secret": null }
```

| 状态 | 说明 | 字段 |
|---|---|---|
| `pending` | 等用户在飞书点同意 | `verification_url` |
| `completed` | 应用已创建且三项校验跑完 | `app_id`、`checks`；`app_secret` **默认 `null`**，只有带 `&reveal_secret=1` 时才一次性返回（兜底手动路径，返回后不销毁凭证） |
| `expired` | 会话超过 10 分钟 | 无（HTTP 410 + 成功信封，`data.status = "expired"`） |
| `failed` | 创建失败 | `error`（可读原因） |

- `checks`：`{ "token": "ok" | "failed", "read": "ok" | "failed", "write": "ok" | "failed", "publish": "ok" | "failed", "details": "…", "publish_details": "…" }`
- 三项校验失败**不删会话**：让宿主能拿到 `checks` 告诉用户「差哪一步」（加成协作者 / 给编辑权限）
- 凭证销毁只发生在「配对取走」或 `completed` 后 15 分钟；`reveal_secret=1` 只是允许宿主看一眼，不改变生命周期
- **主路径宿主不要读 `app_secret`**：Secret 由插件用配对码自取（§8），避免进入宿主上下文

---

## 八、配对（把凭证交给 Chrome 插件）

插件在用户浏览器里，没有 host_token，也不能让用户手抄 Secret。用一次性的 6 位配对码：

```
插件「一键配置」：本地生成 6 位码（100000–999999）→ 显示给用户 → 每 3 秒轮询 GET /api/setup/app/pair?code=CODE
用户：把 6 位码告诉宿主
宿主：POST /api/setup/app/pair { session, code }   ← 只做绑定，不拿 Secret
插件：下一次轮询命中 → 拿到 { app_id, app_secret, app_token } → 存 chrome.storage.local
```

- `POST /api/setup/app/pair`（`requireHost()` 通过）：校验 session 为 `completed`、code 为 6 位数字 →
  绑定 `code → session`，返回 `{ paired: true }`
- `GET /api/setup/app/pair?code=`（**无需鉴权**）：
  - 未绑定/码错 → 404 `SETUP_PAIR_CODE_INVALID`
  - 命中 → 返回 `{ app_id, app_secret, app_token }`，**一次性**，返回后立即从内存删除凭证与会话
  - 只允许同码 20 次尝试（内存计数），超出 429 `RATE_LIMITED`（防爆破；6 位码 + 10 分钟 TTL 已够 MVP）
- 插件拿不到 Secret 之外的任何东西；宿主/模型上下文里**永远不出现 Secret**

---

## 九、纯函数与自测

必须可单测、不碰网络的模块：

| 模块 | 职责 | 自测脚本 |
|---|---|---|
| `src/lib/date.ts` | 日期解析/加减/时区 | `scripts/date-check.ts` |
| `src/lib/token.ts` | 授权码、host_token、question_id | `scripts/token-check.ts` |
| `src/lib/selection.ts` | 选题、打散 | `scripts/selection-check.ts` |
| `src/lib/questions.ts` | 题面构造 | 并入 `selection-check.ts` |
| `src/lib/review.ts` | submit 编排（判分→档位→状态→updates） | `scripts/review-check.ts` |
| `src/lib/feishu/session-store.ts` | 创建会话 TTL / 一次性交付 | `scripts/setup-app-check.ts` |

脚本统一用 `npx tsx scripts/xxx-check.ts`，成功时最后一行打印 `✅ N 项断言通过`，失败 `process.exit(1)`。

### 接口级端到端冒烟

`bash scripts/smoke-api.sh` —— 起一个真实的 `next start`（默认端口 3107），用假密钥跑完：

- 授权码 → `host_token`（含校验位错误 401、格式错误 400）
- 鉴权分支（无 token 401 / 坏 token 401 / 过期 token 402 / diagnose 无 token 401）
- `today` 组题（确定性、`context` 恒 null、选项 4 个、归档点不出题、leech 带提示、参数错误）
- `submit`（字母与原文双提交、对/错/提示档位、`updates` 10 字段、下次复习日期、幂等、篡改/过期拒绝）
- `setup` 接口的 401/404/400 分支（**不触发真实飞书调用**）

不依赖飞书凭证，也不依赖模型 Key。

---

## 十、与 Store 文档的差异（✅ 已同步）

> 2026-10-23：Store 的 `skills/readloop` 已按本节同步，版本 **0.2.0**，
> PR <https://github.com/LyraWang6688/ai-capability-store/pull/291>，tag `readloop-v0.2.0`
> （`check_tag_version.py --missing main` 通过：42 个已登记版本都有 tag）。
> 以后再改接口，按本节同样流程更新 Store 文档并 bump 版本 + 打 tag。

本次同步到 Store `skills/readloop` 的差异清单（留档，改接口时对照）：

1. `submit` 的 `updates` 增加 `难度因子`、`最近暴露` 两个字段（不写回会丢 ease）
2. `submit` 的 `answer`：选择题支持「选项原文」或「字母 A/B/C/D」，两者都判对
3. `today` 的 `options` 是 4 个（正确答案 + 3 个干扰项）；Store 示例里的 3 个只是示例
4. `today` 的 `answered` 字段语义（服务端不记进度，恒为 0）
5. 配对流程：`POST pair` 只绑定，Secret 由插件用 `GET pair?code=` 自取（宿主上下文不出现 Secret）；
   `status` 默认不返回 `app_secret`，兜底手动路径要带 `&reveal_secret=1`
6. 题面 MVP 走确定性模板，LLM 润色默认关闭（`READLOOP_QUESTION_LLM=1` 开启）
7. `status` 的 `checks` 增加 `publish` / `publish_details`；`expired` 用 410 + 成功信封；
   配对 GET 超过 20 次尝试返回 429 `RATE_LIMITED`
