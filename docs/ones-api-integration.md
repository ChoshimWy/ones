---
document_id: TSD-ONES-001
document_type: technical-design
version: "1.1.0"
status: draft
owner: TBD
related_requirements: ["REQ-ONES-001", "REQ-ONES-002", "REQ-ONES-003", "REQ-ONES-004"]
related_documents: ["TSD-COHO-001: coho-attendance-api.md"]
updated_at: "2026-11-09"
source_identity: "仓库基线 22c0c86f0981bb54679812511e4b0ad3717c2868；内网 ONES release_version=v6.18.7、build_version 为空；前端 733.9178f7c8.js、734.03b4e2e4.js、app.842f08a8.js、index.dff858f5.js"
evidence: ["EV-ONES-001: 本文第 8 节脱敏只读实测", "EV-ONES-002: 本文第 8 节静态调用链", "EV-ONES-003: 本文第 9 节官方参考", "EV-ONES-004: 单笔工时提交与回读", "EV-ONES-005: 原记录描述补全与回读"]
---

# ONES 接口与 Orca 接入规则

## 1. 结论与范围

本文件是当前内网实例的接口契约草稿，涉及凭证、业务写入及个人工时，按 L3 边界记录。**文档完成不代表插件完成。单笔工时添加与原记录描述更新已实测；其它写操作及异常恢复仍未验证。**

| 证据标签 | 含义 |
| --- | --- |
| `LIVE-READ` | 2026-11-06 在该实例执行过限定只读请求；仅证明对应样本 |
| `LIVE-WRITE` | 用户明确授权后执行过具体写入并回读；不泛化到其它参数、对象或异常场景 |
| `STATIC` | 当前前端代码存在该调用；对应操作未执行写验证 |
| `REFERENCE` | 官方文档说明；未证明该部署兼容 |
| `GAP` | 契约或验收尚不完整；禁止启用依赖它的写能力 |

需求真源为本次用户确认，ID 在本文首次定义：

| ID | 范围与可观察验收 |
| --- | --- |
| REQ-ONES-001 | 按实例、团队、项目、Bug 类型和负责人读取列表/详情；身份稳定、过滤正确、分页不漏读 |
| REQ-ONES-002 | 读取本人已有登记工时；依据 Coho 有效工时额度手动分配，确认后逐项提交并回读，不重复、不超额 |
| REQ-ONES-003 | 支持新建 Bug、修改 Bug 内容及单独触发状态流转；每项写操作显式确认，遵守动态必填字段与权限 |
| REQ-ONES-004 | 原 ONES Bug 关联 Orca 实施任务；不自动创建 ONES 新任务、不转换原 Bug 类型、不自动改状态；Agent 完成不等于验收完成 |

“Bug 提交”在本文分成**新建缺陷、更新内容、提交状态流转**三种操作，不将其混为一个自动动作。删除 Bug、批量流转、替他人填报、附件上传、自动评论及修改团队设置不在首版自动化范围。

## 2. 实例、认证与版本边界

### 2.1 地址与身份

```text
ONES_ORIGIN = http://aputureones.com:8088
PROJECT_API = {ONES_ORIGIN}/project/api/project
TEAM_API    = {PROJECT_API}/team/{teamUUID}
```

- 该 HTTP 地址是用户指定的内网例外，不擅自切换 HTTPS；仅允许这个完整 origin（含端口）。不是对其它 HTTP 服务的授权。
- HTTP 上的密码、Token 和业务数据没有 TLS 传输保护；仅在可信内网/VPN 使用。密码加密、JWT 或哈希都不能替代 TLS。
- `teamUUID`、`projectUUID`、`taskUUID`、`issueTypeUUID`、`userUUID` 必须从当前账号有权访问的对象获取；示例不携带真实 ID。
- ONES UUID 不等于通用 UUIDv4。任务显示编号 `number` 只用于展示，不能作为跨项目/实例唯一键。
- 规范来源键：`instanceId + teamUUID + taskUUID`；`instanceId` 来自受控实例配置，不接受 Bug 正文或外部 `sourceNamespace` 覆盖。配置 URL 禁止 userinfo、凭证 query 和 fragment。

### 2.2 当前有效认证方式

本次复用了已登录 ONES 浏览器会话；**未使用聊天中提供的密码重新登录**。使用其访问令牌执行同源请求，显式 `credentials: omit`，成功读取身份和业务数据，因此本次样本不依赖附带 Cookie。

```http
Authorization: Bearer <access-token>
Content-Type: application/json
Accept: application/json
```

`GET {PROJECT_API}/users/me` 返回**顶层用户对象**，`uuid` 与当前会话一致。每次连接、切换账号/团队或恢复认证后均需核对身份，不能仅凭本地缓存认定当前操作者。

认证能力分界：

| 能力 | 状态与接入方式 |
| --- | --- |
| 浏览器已登录会话 → 访问令牌 → 只读 API | `LIVE-READ`；令牌只在认证组件内使用，不进入模型上下文/业务 DTO |
| 直接账号密码登录 | `STATIC/GAP`：前端常量为 `auth/v2/login`；独立登录完整参数、加密/SSO/MFA 分支、响应与续期未实测，不提供猜测的密码请求 |
| 过期/刷新 | `GAP`；首版停止请求并提示重新认证，不猜 refresh endpoint，不循环尝试密码 |
| 旧认证头 | `REFERENCE`：旧文档使用 `Ones-User-Id`、`Ones-Auth-Token`；不得和当前 Bearer 方案混用或自动降级 |

旧认证协议参见[官方旧式 API 概述](https://docs.ones.cn/project/open-api-doc/)。当前浏览器存储实现不构成插件公开认证 API；不要依赖读取全部 localStorage，正式插件需单独闭合安全授权/凭证提供通道。

安全存储优先系统凭据库；开发调试只能使用运行时注入，不把密码、访问/刷新令牌、Cookie、密码摘要放入文件示例、CLI 参数、README、Git、错误日志或 Agent 提示词。HTTP 重定向默认拒绝，禁止把认证头转发给其它 origin。

### 2.3 不混用 API 家族

本实例实际使用 `/project/api/project/team/...` REST 与 `items/graphql`。新版官方 OpenAPI 的 `/project/issues/:issueID/workLog/...` 是另一套接口契约，认证、字段、工时单位和模式都应单独验证。

例如新版简单模式工时写入文档使用 `hours` 小时数；**不要将本文件的 100000 倍定点整数套用过去**。[新版官方简单模式工时接口](https://docs.ones.com/zh-Hans/developer/openapi/api/04-add-spent-time-of-issues/)

## 3. 接口索引与共同响应规则

下表中 `/version`、`/users/me` 相对 `PROJECT_API`；其余相对 `TEAM_API`。

| 功能 | 方法与路径 / 操作 | 证据 / 开放边界 |
| --- | --- | --- |
| 版本 | `GET /version` | `LIVE-READ`：`release_version=v6.18.7` |
| 当前用户 | `GET /users/me` | `LIVE-READ`：顶层用户对象；只取业务所需 ID |
| 团队与工时配置 | `GET /info` | `LIVE-READ`：顶层团队对象 |
| Bug/任务列表、GraphQL 详情 | `POST /items/graphql?t=Task`，只读 `query` | 列表 `LIVE-READ`；单项也可用 `uuid_equal` 过滤，完整详情优先下列已测 REST |
| Bug/任务详情 | `GET /task/{taskUUID}/info` | `LIVE-READ`：顶层 task 对象，不是 `{task: ...}` |
| 工时列表 | `POST /items/graphql?t=Manhour`，只读 `query` | `LIVE-READ`：`data.manhours` 或 `data.buckets[].manhours` |
| 添加登记工时 | `POST /items/graphql?t=Manhour`，`addManhour` mutation | `LIVE-WRITE`：单笔提交及按 key 回读；EV-ONES-004 |
| 补全工时描述 | 同上，`updateManhour` | `LIVE-WRITE`：仅描述字段更新，原 key/时长/日期/归属/条数不变；EV-ONES-005 |
| 其它修正/删除工时 | 同上，`updateManhour` / `deleteManhour` | `STATIC`：时长等其它字段更新和删除未测；独立确认，不作为自动回滚 |
| 新建 Bug | `POST /tasks/add3` | `STATIC`；动态创建字段合同有缺口，默认关闭 |
| 修改 Bug 内容 | `POST /tasks/update3` | `STATIC`；只提交用户确认的字段，不携带陈旧完整对象 |
| 可用流转 | `GET /task/{taskUUID}/transitions` | `LIVE-READ`：`transitions[]` |
| 执行流转 | `POST /task/{taskUUID}/new_transit` | `STATIC`；步骤必填字段/后置动作需预检 |
| 项目、类型、字段/选项/权限元数据 | 按当前前端对应配置接口接入 | `GAP`：尚未完整验证，不硬编码生产枚举 |
| 评论/附件 | 暂不启用 | `GAP`：另行核实上传、签名 URL、消息模型及授权 |

`?t=Task/Manhour` 是前端请求标识，不是权限控制。HTTP `POST` 不一定写入：GraphQL `query` 是读取；反之不能只靠 URL 判定只读，需限制 operation 和允许的根字段，禁止将任意 GraphQL 文本暴露给执行 Agent。

成功判定：

- HTTP 成功之外，检查 JSON 形状及业务错误；HTML 登录页不是成功。
- GraphQL 有 `errors` 时，不把局部 `data` 当作完整结果。缺少预期字段、未知 schema 或无法解释的空结果应降级为失败/不完整。
- REST 创建/更新要逐项检查 `tasks` 与 `bad_tasks`，不能把 HTTP 200 当作批量全成功；当前写响应尚待实测。
- 401：终止当前操作、重新认证；403：保留“无权限”，不伪装空列表；404：资源删除或身份/范围不匹配，重新定位；429：读请求按服务端限流信息退避；5xx/网络中断：读可有界重试，写按第 7 节处理。
- 不输出原始响应。普通日志只允许操作名、参数化路径、状态码、错误分类、数量、耗时和本地请求标识；业务 ID、原始错误文本及正文进入受控本地诊断前必须脱敏。

## 4. Bug 读取与分页

### 4.1 有界列表查询

以下 query 已在该实例验证过结构，`variables.filter` 的实际 ID 已脱敏；示例 `20` 是本次读取上限，不是完整同步协议。

```graphql
query DocBugs($filter: Filter) {
  tasks(filter: $filter, limit: 20, orderBy: {serverUpdateStamp: DESC}) {
    uuid key number name
    project { uuid }
    issueType { uuid name }
    status { uuid name category }
    assign { uuid }
    serverUpdateStamp
  }
}
```

```json
{
  "filter": {
    "assign_in": ["<current-user-uuid>"],
    "project": {"uuid_in": ["<selected-project-uuid>"]},
    "issueType_in": ["<bug-issue-type-uuid>"]
  }
}
```

请求体为 `{"query": "<上述 query 字符串>", "variables": {"filter": {}}}`，填入上面的真实运行时过滤器。不得把示例空过滤器用于生产全团队扫描。

- 当前样本工作项类型显示为“缺陷”，但类型判断必须使用配置元数据返回的 ID；不能用标题含“Bug”或名称固定为“缺陷”进行业务识别。
- 状态筛选、父子类型和项目范围依赖实际元数据。本次查询未限定状态；不能称为“待处理 Bug 列表”。
- 列表 DTO 与权威详情分离：展示副本用于 UI，实施/写入前重新取详情及权限。字段映射为 `name ↔ summary`、GraphQL `status.uuid ↔ status_uuid`，不要把 REST 数值 `status` 误认成工作流状态。

### 4.2 完整列表使用 bucket 游标

下式分页结构已用本人任务/工时各两页、每页 1 条核实。示例保留 `1` 以便最窄复验；实现可配置页大小，不把它作为产品性能预算。

```graphql
query DocPage($filter: Filter) {
  buckets(
    groupBy: {tasks: {}}
    pagination: {limit: 1, after: "", preciseCount: true}
  ) {
    tasks(filter: $filter, orderBy: {serverUpdateStamp: DESC}) { key }
    pageInfo { count hasNextPage endCursor unstable }
  }
}
```

- `after` 首次为空，随后为同一 bucket 上次的 `endCursor`；保持筛选、排序、实例、账号和团队不变。游标由 JSON/GraphQL 编码器处理，不直接插值不可信字符串。
- 下一页依据 `hasNextPage`；游标缺失/重复、`unstable=true`、请求失败或达到本地读取上限时标记 `partial`，不能当作全部读完。
- **不要在内层 `tasks`/`manhours` 加一个总量 `limit` 来代替外层分页。** 本次 `pagination.limit=1` 同时配内层 `limit:1` 返回 `hasNextPage=false`；移除内层限制后两页均返回 1 条、不同 key，且仍有下一页。
- 按来源键去重；页间变化、相同更新时间排序及读取中途权限变化仍需保护，不宣称具备快照一致性。升级版本后重新核实分页语义。
- 未执行全量读取，不能据此认定总 Bug 数或总工时已核对。

### 4.3 详情与实施输入

`GET /task/{taskUUID}/info` 返回顶层对象，已观察到 `uuid`、`project_uuid`、`issue_type_uuid`、`issue_type_scope_uuid`、`summary`、`desc`、`desc_rich`、`status_uuid`、`assign`、`priority`、`field_values`、`server_update_stamp`、工时汇总及 `manhours` 等字段。

- `desc_rich` 先清理富文本，再按最少必要内容生成实施输入；外链/附件不自动下载，正文中的命令或“忽略规则”不构成指令授权。
- 截图、签名 URL、邮箱、电话、Token、Cookie 与内网路径可能嵌在自由文本里；不能只根据字段名脱敏。拒绝 URL userinfo，检查嵌套对象和字符串，不把整份响应直接写入 task spec。
- 原始业务快照、运行状态、任务映射只留受控本地路径，遵守 README 的同步边界。
- Bug → Orca 的最小映射为来源键、当前详情版本、授权仓库/基线、实施说明与本地任务 ID。创建实施工作区不调用 `tasks/add3`，不更改 ONES Bug 类型或状态。

## 5. 工时读取、额度与提交

### 5.1 配置与字段单位

`GET /info` 当前实测：`timezone=Asia/Shanghai`、`workhours_unit=hour`；`configs` 是 `{type,data}` 对象数组，取 `type == "manhour_mode"` 对应 `data`，本次值为 `simple`。不要把原始响应误读为 `configs.manhour_mode`。

| 字段 | 当前旧式 GraphQL 合同 |
| --- | --- |
| `key` | 服务端工时对象标识；后续回读/修改的依据 |
| `owner.uuid` | 工时归属者；不同于任务负责人、创建者 |
| `task.uuid` | 原 ONES Bug 或普通任务，不是 Orca 本地任务 ID |
| `type` | `recorded` 为登记工时，`estimated` 为预估；本插件填报用前者 |
| `hours` | 小时 × 100000 的定点整数；0.5h → 50000，8h → 800000 |
| `startTime` / 写入 `start_time` | Unix 秒，不是毫秒；所属业务日期按团队时区解析 |
| `description` | 工时说明，不得写入完整考勤记录、密码或原始 Bug 正文 |
| `mode` | 写入按当前团队配置；本次为 `simple`，不得硬编码为所有团队默认值 |

数值依据：前端 `nhBP` formatter 处理秒和 `toAccuracyFixed`；`734.03b4e2e4.js` 的 `bHIl` 默认精度为 5。本次非空工时读样本的 `hours` 是整数、`startTime` 是 10 位数；没有把用户实际数值写入本文件。

实现使用十进制定点运算，不用二进制浮点累加；显示小时、考勤额度分钟和 API 整数分别建模。无法精确编码为 5 位小数的输入应要求调整/确认，禁止悄悄舍入后提交。半小时是考勤折算规则，不自动推断为所有人工分配项的唯一合法粒度；分配输入粒度需在插件实现时明确。

### 5.2 本人既有工时查询

```graphql
query DocDayHours($filter: Filter) {
  manhours(filter: $filter, limit: 20, orderBy: {startTime: DESC}) {
    key hours startTime type owner { uuid } task { uuid }
  }
}
```

```json
{
  "filter": {
    "owner_in": ["<current-user-uuid>"],
    "type_equal": "recorded",
    "startTime_range": {"from": "<YYYY-MM-DD>", "to": "<YYYY-MM-DD>"}
  }
}
```

- 指定任务时可再加 `task_in: ["<task-uuid>"]`，该过滤已实测；计算日额度扣减时不能只查用户本次选中的任务，应覆盖本人该日全部适用登记工时。
- 上式是有界检查。完整读取复用第 4.2 节，把 `groupBy/tasks` 换成 `manhours`、内层排序改为 `startTime: DESC`，不要保留内层 `limit`；工时分页已单独验证。
- 初始单日查询为空；后续单笔提交及描述更新回读均得到匹配记录。已核实指定业务日 09:00 的样本，不代表午夜边界、起止包含规则和跨日归属已验证；这些场景在自动化开放前仍须补证。
- `estimatedHours`、`totalManhour`、`remainingManhour` 等任务汇总不能代替按人/日期的登记明细；也不能以总工时差值作为唯一写入凭证。

### 5.3 考勤到任务的分配规则

折算算法唯一真源为 [TSD-COHO-001，第 6 节](coho-attendance-api.md#6-已确认的工时规则)，不在本文件维护第二份算法。

确认的业务样例：09:00–18:30 → 8h；09:15–21:00 → 10h；09:00–20:00 → 9h。特殊打卡、跨日和未确认的迟到/早退情况按考勤文档要求人工确认，不自动视为完整基础日。

本接入的安全约束：

1. 先明确当前 ONES 用户与 Coho 员工的人工确认映射；不能用姓名相同、任务负责人或 `globalId == userUUID` 猜测身份。
2. 计算当天可分配额度，展示依据与异常；用户手动分配到有权限的 Bug/任务，不按任务数自动均摊。
3. 查询当天完整已有登记工时，区分已有记录、待新增和拟修正；已有记录默认不重复补登。
4. 提交前重算：已有适用工时 + 本次拟新增净额不得超过已确认有效工时；资料不完整/归属不明时停止自动提交。未分配余额可以保留，不强制填满。
5. 预览账号、团队、日期/时区、每个任务、时长和说明；说明遵守第 5.5 节的非空及内容确认规则。确认绑定该份精确 payload；任何字段（包括描述）改变后，原确认失效。
6. 逐项提交并回读；只把已确认成功的行扣入本地已提交记录。部分成功保留逐项结果，不重发整批。

修正已有工时属于独立写入：先取得原记录、明确增减差额，再更新额度；不能把“再添加一条负数工时”当撤销。

### 5.4 添加登记工时：单笔提交及回读已验证

当前前端经 `48IU → iqX+ → NAep → items/graphql` 生成 `addManhour` mutation。2026-11-06 已在用户指定的单笔真实工时上完成提交及回读。以下 query/变量结构为实测形状，所有身份值须运行时获取；不是自动执行写入的授权：

```text
POST {TEAM_API}/items/graphql?t=Manhour
```

```graphql
mutation AddManhour {
  addManhour(
    task: $task, owner: $owner, type: $type, hours: $hours,
    start_time: $start_time, description: $description, mode: $mode
  ) { key }
}
```

请求体为 `{"query":"<上述 query>","variables":{...}}`。实测 variables 使用 `type="recorded"`、`mode="simple"`、定点 hours、Unix 秒 start_time；初次 description 为空虽被服务端接受，但不符合后续确认的第 5.5 节业务规则，不应照抄该空值。

| 参数 | 插件输入约束 |
| --- | --- |
| `task` | 已读回且用户选定的 ONES task UUID |
| `owner` | 当前已验证的本人 ONES user UUID；代填不开放 |
| `type` | `recorded`；不使用 `estimated` 冒充实际工时 |
| `hours` | 正数定点整数，例如 0.5h 为 50000；满足实际团队限制 |
| `start_time` | 用户确认业务日期对应的 Unix 秒；日期锚点/午夜归属待验证，不直接使用当前提交时间 |
| `description` | 必须包含用户确认的非空工作描述；缺失时暂停该笔提交，规则见第 5.5 节 |
| `mode` | 从团队配置取得，本次 `simple` |

现有前端通过运行时对象生成参数/variables；以上单笔参数组合已成功，其它可选字段、限制与失败结构仍需获准后定向验证。旧官方示例也包含 `hours_format` 等参数，不能未经核实复制进当前 `simple` 模式。[官方旧式 GraphQL 工时示例](https://docs.ones.cn/project/open-api-doc/graphql/example.html#工时)

成功条件为返回对象 key、无业务错误，并按 key 回读验证 owner、task、type、hours、业务日期和说明。仅 mutation 返回 key 尚不足以宣称写入正确。已实测 `manhours(filter: {key_equal: <returned-key>})` 查询定位单笔，并与本人/任务/日期查询交叉核对；不能只看任务总工时增量。

### 5.5 描述必填与原记录补全

本项目的业务规则（非 ONES 服务端必填声明）：

1. 每笔新增工时必须包含非空、非纯空白的 `description`，并在提交预览中完整显示。缺少描述时先询问用户，不能静默发送空字符串。
2. 可以将所选任务标题作为候选描述，但必须得到用户确认；更具体的工作内容由用户提供或确认，不编造修复范围、完成情况或验收结果。描述不允许携带凭证或原始考勤数据。
3. 对已登记但缺描述的工时，只补原记录，不调用 `addManhour`、不删除重建、不把原日期改为补填当天。
4. 优先使用原写入返回 key；缺少保存的 key 时，使用当前账号、团队、任务、原开始时间、时长和类型完整匹配，并要求查询完整且唯一。零条、多条或已有非空不同描述时停止并让用户确认，不覆盖现有内容。
5. 更新前重新读取记录，确认描述仍为空；若已经等于目标描述则不再写。原 key、owner、task、type、startTime、hours 必须保持不变，记录条数及合计工时不增加。
6. 更新后按 key 回读精确比对描述，再核对原字段、条数和合计；超时或不明响应遵守第 7 节，不盲目重试。

已验证的最窄更新请求（同一 `items/graphql?t=Manhour` 端点）：

```graphql
mutation UpdateManhour {
  updateManhour(key: $key, description: $description, mode: $mode) { key }
}
```

variables 只带已核实的原 key、用户确认的描述和当前团队 mode；本次 mode 为 `simple`。**不回传整个旧记录，也不附带 hours/start_time/owner/task 去覆盖原字段。** 2026-11-09 实测更新成功且保护字段不变；并发条件更新/CAS 仍未证明支持。

其它字段修改及 `deleteManhour` 尚未写验证。未经用户再次明确确认，不自动修改/删除以补偿部分失败。插件首版默认不开放预估工时、剩余工时和团队模式设置。

## 6. Bug 提交与状态流转

### 6.1 新建 Bug

当前前端调用 `POST {TEAM_API}/tasks/add3`，请求外层为 `tasks` 数组。每项默认通过当前用户生成 uuid，并设置 assign/summary/parent_uuid；最终字段会经过表单 formatter。以下是**字段形状示例，不是无需元数据即可提交的完整合法请求**：

```json
{
  "tasks": [{
    "uuid": "<client-generated-task-uuid>",
    "project_uuid": "<selected-project-uuid>",
    "issue_type_uuid": "<bug-issue-type-uuid>",
    "assign": "<selected-assignee-uuid>",
    "summary": "<user-confirmed-title>",
    "desc_rich": "<sanitized-description>",
    "parent_uuid": "",
    "field_values": []
  }]
}
```

- 当前创建路径是 `add3`，旧官方示例 `add2` 仅作参考，不自动回退。[官方旧式工作项接口](https://docs.ones.cn/project/open-api-doc/project/task.html)
- 必须先读取项目、Bug 类型/作用域、创建表单、字段选项、默认值和当前权限；确认严重程度、优先级、版本、复现步骤、预期/实际结果等哪些是必填。`field_values: []` 不代表本实例允许空自定义字段。
- `issue_type_scope_uuid` 已在当前详情观察到，但创建时如何传递以及 scope 对表单的影响尚未闭合；不能仅照旧版 `project_uuid + issue_type_uuid` 假定所有项目可创建。
- task UUID 按当前前端生成规则核实后一次生成并保留；不随网络重试重新生成。显示编号和创建者由服务端确定，不把 UI 任意输入当权限。
- 预览全部字段、负责人、项目和类型后才提交；新建 Bug 与 Bug → Orca 实施是两个独立入口。
- 成功后检查逐项成功/失败结果，再按 task UUID 回读类型、项目及用户提交字段；超时转入结果待核实，不重复新建。

### 6.2 修改内容

`POST {TEAM_API}/tasks/update3` 的前端请求形状为 `{"tasks": [...], "must_all_succeed": <boolean>}`。当前前端有逐项 `bad_tasks` 处理，不将该参数视为已证实的跨系统事务保证。

更新前重新读详情与 `server_update_stamp`；向用户展示变化，只提交允许且确认的字段差异。版本戳用于发现陈旧编辑，**未证明服务端支持条件更新/CAS**；存在并发变化时重新确认，而不是直接覆盖。

内容更新不隐式修改状态、类型、项目、工时汇总或其它人的更改。字段编码和权限按当前 schema；不能把只读响应整个回传。

### 6.3 提交流转

1. `GET /task/{taskUUID}/transitions`，读取当前任务可见步骤。
2. 展示当前状态、目标状态、步骤和所需输入，补齐该步骤的字段/评论/工时/附件约束。
3. 用户明确确认后 `POST /task/{taskUUID}/new_transit`，核心参数 `transition_uuid`；当前前端也会合并步骤表单参数。
4. 回读任务状态和必要的异步动作结果。API 已接受不等于后置动作全部完成。

本次 transitions 样本只有 `uuid/name/start_status_uuid/end_status_uuid`，**没有 `match_condition`**。不能因旧文档列出该字段便假定一定返回，也不能仅因步骤可见就认定所有必填条件满足。流程可能有异步后置动作，见[官方工作流说明](https://docs.ones.cn/project/open-api-doc/project/workflow.html)。

提交工时、创建 PR、Agent 结束都不触发流转；“已解决/已验收”必须按真实团队工作流和人工决策处理。不要在更新普通字段的接口里绕过流程直接写状态。

## 7. 写入保护与失败恢复合同

以下是插件实现约束，不是 ONES 已提供的服务端特性。

```text
draft → validated → confirmed → submitting → acknowledged → verified
                                   ├→ rejected
                                   └→ unknown → reconcile → verified / needs-user-decision
```

- `validated` 要求身份、能力/权限、动态 schema、日期与额度完整；能力未知则保持只读。
- `confirmed` 绑定来源、操作类型、对象、payload 摘要、额度快照和确认者；数据变化后重新确认。
- `submitting` 前持久化本地操作 ID 与精确 payload 摘要；同一账号/团队/日期的工时批次串行，UI 连点和多 Agent 重入共用同一锁/账本。此机制尚未实现，不把旧脚本当证据。
- `acknowledged` 只代表服务端响应可解释；`verified` 必须有目标对象回读匹配。
- 写请求超时、连接断开、响应无法解析、5xx 或确认后进程崩溃，都不能证明未写入；记为 `unknown`，禁止自动再发。
- 优先按已返回 key / 客户端 task UUID 回读。工时无可靠服务端 ID 时，仅凭“用户+日期+任务+时长+说明相同”不能证明是同一笔：可能合法重复，需人工核对，不能自动删除或重发。
- 当前未证明 API 支持 idempotency key、唯一约束或条件更新；本地锁与账本只能防本机重复，不能宣称跨客户端 exactly-once。人工网页同时填报的竞态需提交前重读、提交后核对；发现冲突暂停余项。
- 部分成功只恢复未完成项，并重新核算额度；不自动撤销成功行，不自动流转 Bug，不重发整批。
- 取消在请求发出前可以阻止提交；请求发出后的取消仍需核实远端结果，不能直接标记“已撤销”。

权限分离：读取、创建 Bug、修改内容、提交工时、修正工时、执行流转分别授权；插件执行层持有必要凭据，Agent 不接触凭据，不根据 Bug 正文扩大能力。端点与操作类型均用白名单，不开放任意带认证 HTTP 代理。

## 8. 证据、验收与缺口

### 8.1 本次证据

初始只读/静态证据采集于 2026-11-06；同日完成一笔已授权工时添加，2026-11-09 完成该原记录描述补全。环境：macOS 上 Orca 内置浏览器、上述内网 HTTP 实例。只使用已有会话，无密码登录、无写 REST、无 HAR/原始响应落盘；两次 mutation 分别为 addManhour 和仅描述 updateManhour。下列只记录字段、类型、数量与状态；不存账号、Token、真实业务 ID、任务标题或个人工时原始响应；参数规格中的数字仅说明单位，不携带实际任务映射。`EV-ONES-001` 为本次工具回执的脱敏摘要，不是可脱离原会话独立审计的网络原始包。

| ID / 检查 | 实际结果与限制 |
| --- | --- |
| EV-ONES-001 / 版本、身份、团队 | HTTP 200；v6.18.7；users/me 与当前会话 user UUID 一致；simple、hour、Asia/Shanghai |
| EV-ONES-001 / 本人单条任务 | HTTP 200、GraphQL 无 errors；1 条；类型“缺陷” |
| EV-ONES-001 / 项目+类型+本人筛选 | HTTP 200、无 errors；20 条达到查询上限；不是完整清单 |
| EV-ONES-001 / Bug 详情与流转 | HTTP 200；详情顶层 task；1 个可见 transition；未执行流转 |
| EV-ONES-001 / 工时 | 指定任务+本人 recorded 查询成功但为空；本人最近一条查询返回 1 条、整数 hours、10 位 startTime；本人单日过滤为空 |
| EV-ONES-001 / 分页保护 | 内外同时 limit:1 会提前得到 hasNextPage=false；去掉内层 limit 后，任务/工时各两页、每页1条、两页 key 不重复且仍有下一页；未遍历全部 |
| EV-ONES-002 / 静态调用链 | 733 包含 add3/update3/new_transit、GraphQL helper、48IU/iqX+/nhBP/NAep；734 的 bHIl 固定精度5；index 存在 Bearer 格式化/认证引导；没有执行写操作 |
| EV-ONES-003 / 官方资料 | 2026-11-06 查阅第 9 节官方页面；仅作版本差异与字段含义参考 |
| EV-ONES-004 / 单笔添加与回读 | 2026-11-06：一次 addManhour，HTTP 200、无 GraphQL errors、返回 key；按 key 及本人日期回读一致，任务状态不变；空描述被服务端接受，但不满足后续第 5.5 节规则 |
| EV-ONES-005 / 原记录描述补全 | 2026-11-09：原记录匹配唯一且描述为空；一次 updateManhour、零次 add，HTTP 200、无 errors；回读描述一致，key/开始时间/时长/类型/归属保持不变，条数和合计工时不变 |

两次写验证的私有脱敏回执仅保留在本机 chat-scratch（临时目录可能清理），未纳入 Git；摘要用于绑定复用证据，不是独立网络抓包：

- EV-ONES-004 回执 SHA-256：`4797a7dd1ab03239703021993b99c90a89a2cfe5adb40ed3046a265c5afd19c2`。
- EV-ONES-005 回执 SHA-256：`c3fbf121190387504036aa7d7d2071d4bc52bf16fd7f977f46387120ae6fc263`。
- 写操作由用户分别授权，本次仅复用已有证据更新文档，没有重放写请求。单笔添加按用户明确指定值执行，不作为 Coho 自动计算/身份映射已闭环的证据。

前端脚本从 `ONES_ORIGIN/project/scripts/` 读取，具体文件名记录于 source_identity。未来包名或服务端版本变化应重新核对相关契约，不把本次读证据升级为未来写能力。

### 8.2 需求到验收的追溯

| 用例 / 需求 | 实施验收 | 本次结果 |
| --- | --- | --- |
| TC-ONES-001 / REQ-ONES-001 | 本人 Bug 过滤、详情、不同身份不串数据 | 样本过滤/详情 PASS；切换身份保护 NOT_RUN |
| TC-ONES-002 / REQ-ONES-001、002 | 多页读取不漏/重，内层限制不误判完整，变化时标 partial | 两页静态数据验证 PASS；全量结束/并发变化 NOT_RUN |
| TC-ONES-003 / REQ-ONES-002 | 0.5h ↔ 50000、跨午夜、原工时扣减、人工分配不超额 | 单位静态核实；边界和行为测试 NOT_RUN |
| TC-ONES-004 / REQ-ONES-002 | 确认后提交、逐项回读、超时不重发、部分成功可恢复 | 单笔提交/回读 PASS（EV-ONES-004）；超时/部分成功恢复 NOT_RUN；初次空描述不满足新增规则 |
| TC-ONES-009 / REQ-ONES-002 | 确认描述后仅更新原记录，保护字段、条数及合计不变 | 真实补全/回读 PASS（EV-ONES-005）；缺描述阻断、多条匹配、并发变化和已等值跳过等插件负向场景 NOT_RUN |
| TC-ONES-005 / REQ-ONES-003 | 动态必填/无权限拒绝、新建和更新后回读、并发编辑保护 | NOT_RUN：创建 schema/字段权限与写契约未闭合 |
| TC-ONES-006 / REQ-ONES-003 | 可用步骤与必填约束、人工确认、异步后置动作核对 | 流转列表 PASS；执行及后置动作 NOT_RUN |
| TC-ONES-007 / REQ-ONES-004 | 原 Bug 不变、重复实施请求不重复发起、Agent 完成不改 ONES | NOT_RUN：插件未实现 |
| TC-ONES-008 / 全部 | HTTP origin 白名单、拒绝跨域重定向、凭据不进入 task spec/日志 | 本次读取使用同源/拒绝重定向；插件负向测试 NOT_RUN |

### 8.3 下一步与恢复条件

| 缺口 | 影响 / 恢复条件 | owner |
| --- | --- | --- |
| 正式插件授权与认证续期 | 复用浏览器只证明当前 API 访问；指定认证方案、凭据持有层和负责人后实现 | TBD |
| 元数据/创建 schema/权限 | 读取选定项目和类型的字段配置与作用域，固定必填/可编辑字段契约；此前关闭 Bug 写入 | TBD |
| 单日边界及日期锚点 | 用获准样本核实团队时区午夜、起止边界、跨日及未填写日期语义；此前不自动提交工时 | TBD |
| Coho ↔ ONES 身份映射 | 用户确认两个系统的本人身份，并在切换账号时失效重确认 | TBD |
| 写入与回读契约 | 单笔工时添加/描述补全及回读已有证据；其它工时字段、删除、Bug 创建/更新/流转须另取具体测试授权后验证；不能用文档授权代替业务写授权 | TBD |
| 并发与不确定结果 | 先用合成数据验证本地状态机、重复提交、超时/部分成功；真实远端幂等能力未知时保留人工核对 | TBD |

文档任务 ownership 仅 `README.md` 和本文件，canonical Git root 为 `/Users/choshim/Desktop/Aputure/Code/Projects/Ones`；任务分支 `docs/ones-api-integration` 从 `main@22c0c86f0981bb54679812511e4b0ad3717c2868` 建立，Worktree 为 `/Users/choshim/.agent-worktrees/choshimwy-ones/docs/ones-api-integration`。不修改 scripts/tests/config，不因文档生成自动提交、合并或推送。

自检已完成：补齐版本/认证差异、响应顶层形状、分页提前截断、定点单位、跨日证据缺口、动态必填、并发覆盖、超时重复和原 Bug 不变约束。补齐描述非空确认、原记录最窄更新及证据分层；未将单笔成功推广为全部写能力或日期边界通过。N/A：本次文档修订无插件代码、数据库迁移、UI 或线上发布；撤回文档不会撤销已授权的历史业务写入，修订过程没有新增线上写操作。

## 9. 官方参考

- [旧式 API 总览与认证](https://docs.ones.cn/project/open-api-doc/)：与当前 Bearer 实测不同，禁止盲目混用。
- [旧式工作项接口](https://docs.ones.cn/project/open-api-doc/project/task.html)：创建/更新字段与逐项结果参考；当前创建路径以静态发现 add3 为准。
- [旧式 GraphQL 工时示例](https://docs.ones.cn/project/open-api-doc/graphql/example.html#工时)：query 与工时 mutation 名称参考，不作为 v6.18.7 全部参数已验证的证明。
- [旧式工作流接口](https://docs.ones.cn/project/open-api-doc/project/workflow.html)：流转与后置动作参考。
- [新版 OpenAPI 简单模式工时](https://docs.ones.com/zh-Hans/developer/openapi/api/04-add-spent-time-of-issues/)：仅用于 API 家族差异说明，不纳入当前已验证路由。
