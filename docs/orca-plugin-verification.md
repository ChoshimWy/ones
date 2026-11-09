---
document_id: VR-ONES-PLUGIN-001
document_type: verification-report
version: "0.4.0"
status: draft
owner: "Main：实施与定向验证"
related_requirements: ["REQ-ONES-001", "REQ-ONES-002", "REQ-ONES-003", "REQ-ONES-004"]
related_documents: ["IMP-ONES-PLUGIN-001: orca-plugin-plan.md", "TSD-ONES-001: ones-api-integration.md", "TSD-COHO-001: coho-attendance-api.md"]
updated_at: "2026-11-09"
source_identity: "main@9c83db0bc7cf980cd39201785cde15edc5ad4f19 + feat/ones-workbench 未提交变更；源码冻结结果见本机 chat-scratch/7330a24ebd94185a9f48bb35ee55a1ff/ones-plugin-bug-row-identity.json；宿主扩展身份仅为历史，文档不嵌自身指纹以避免递归变更"
evidence: ["EV-PLUGIN-002: 本会话定向 runner 结果", "EV-PLUGIN-003: Orca plugin validate/check 结果", "EV-PLUGIN-004: Orca dev load/open/status 与真实登录现场"]
---

# ONES 工作台：阶段验证报告

## 1. 判定与环境

**完整方案验收不通过；开发原型部分完成。** 不能将虚构 fixture 的提交成功写成真实工时成功。生产 Worker 固定 `writesVerified: false`，没有可绕过的 UI 设置；未修改真实工时、Bug、工作区或启动 Agent。

- 仓库、基线、Worktree、ownership 与 DAG 见 [规划 §5](orca-plugin-plan.md#5-实施-dag-与写入所有权)。主仓保持只读，未提交、合并或推送。
- 2026-11-09：本机 macOS arm64，Orca 1.4.254 / `9b9363f4fb130969e63e4a31ecac6d4f569d77a8`；初始脚手架为 1.4.253，重启后刷新 1.4.254 官方类型与指南。
- TypeScript 7.0.2、Node 26；类型检查复用本机已安装编译器，锁文件离线生成，没有安装生产依赖。
- 用户单独同意临时加载 trusted-worker、storage:own、secrets:own 后加载成功。首次 Worker `status` 为未登录；完成修复及用户界面登录后，两站均 `connected:true`，`writeEnabled:false`。ONES 用户已确认登录成功。

## 2. 风险映射与实际证据

以下原生面板与宿主扩展证据为迁移前历史；最终 HTML 展示层的有效结果见文末“仅插件 HTML 面板”。未变化 Worker 的接口/安全证据按范围复用，不把旧面板测试算作新 UI 通过。

完整验收要求、REQ/DEC/TASK 关系只在 [规划 §6](orca-plugin-plan.md#6-追溯与最窄验收) 定义。下表是已执行子场景，不将整条 TC 标成通过。

| 用例子范围 | 实际结果 | 未覆盖 |
| --- | --- | --- |
| TC-PLUGIN-001：exact origin、独立 OAuth、受保护存储不可用 | 虚构请求通过；密码加密、跨站拒绝、无浏览器状态、不可用时零网络请求 | 宿主桥接日志全链路审计及高级认证分支 |
| TC-PLUGIN-001-cancel | 模拟保存令牌期间取消，完成后不恢复连接、不残留该会话 | 多进程、宿主崩溃 |
| TC-PLUGIN-001-diagnostics | HTTP 错误仅暴露固定步骤和状态码，不泄露响应体或跳转查询 | 所有上游错误类型 |
| TC-PLUGIN-001-finalize | 补齐组织授权；正常流程、scope 不匹配、跨站地址和 state 篡改拒绝通过 | 验证码/MFA 等高级认证未覆盖 |
| TC-PLUGIN-003 | 已确认打卡边界、未满半小时、特殊 09:15、缺卡/跨日/未知外勤阻断通过 | 跨期、异常班次与外勤政策 |
| TC-PLUGIN-003/004 | 无考勤无法预览、直接 submit 拒绝、已有工时/考勤变化后写前拒绝、退出 Coho 后不能读取通过 | 服务端并发及真实日期边界 |
| TC-PLUGIN-004 | 意图落盘先于提交；未知结果/重启阻断新写；回读不匹配拒绝；磁盘失败零写入通过 | 服务端 CAS、跨客户端一致性及真实未知结果恢复未验证 |
| TC-PLUGIN-004-positive | 两笔虚构工时逐笔提交和回读、保留历史日期、第二次提交不新增通过 | 真实工时提交/补描述端到端未执行 |
| TC-PLUGIN-004-recovery、004-description | 5 项虚构服务测试通过：重启排除旧记录、人工确认后恢复且后续补描述可执行；零/多匹配、预览后变化、身份变化、损坏账本保持阻断；描述回包丢失零额外写入；保护字段变化和落盘失败拒绝 | 真实服务端不确定结果、并发、磁盘崩溃及人工归属判断 |
| TC-PLUGIN-007-recovery | 歧义无确认入口、唯一项必须勾选、确认只更新本地、生产补描述按钮禁用通过 | 实际写入、完整键盘与无障碍交互 |
| TC-PLUGIN-007 | 遮罩密码、提交/卸载清空、无考勤禁用新增的 2 项面板测试通过 | 键盘、长标题、全部业务状态及真实 API 联动 |
| TC-PLUGIN-002-page、TC-PLUGIN-007-page | 有界页/续页/不稳定拒绝及 UI 按需追加通过；真实前两页各 50 条、无重复且仍有下一页 | 完整团队元数据及全部分页故障 |
| TC-PLUGIN-001-coho-context、TC-PLUGIN-003-self-attendance | ATS 请求上下文保持、本人身份绑定、使用权威考勤期、缺期拒绝通过 | 其它租户/跨期 |
| TC-PLUGIN-005、006 | 未执行完整验收 | 实施启动/恢复、Bug 动态写入 |

已执行风险子用例 26 个唯一名称均曾通过（完整状态配置本轮新增 4 个）；不是全方案覆盖率。前两项面板测试最初失败于 Callout/EmptyState 的文本定位断言，核对实际树后修正并定向通过。后续只对新增/变化风险定向运行，不运行全量 `plugin test`，不以累计次数扩大通过数。

### 执行命令口径

从任务 Worktree 执行 Node `--test`，安装版官方 loader 为 `/Applications/Orca.app/Contents/Resources/app.asar.unpacked/resources/plugins/declarative/orca-test-register.mjs`，`ORCA_PLUGIN_TEST_ROOT` 指向 `plugin/`；文件为 `plugin/tests/protections.test.ts`、`plugin/tests/panel.test.tsx` 或 `plugin/tests/recovery.test.ts`，`--test-name-pattern` 精确选择上述名称。

初始选择器 `TC-PLUGIN-00[1347]:`、面板修复选择器 `TC-PLUGIN-007:|TC-PLUGIN-003/004:`、竞态/写前风险选择器 `TC-PLUGIN-001-cancel:|TC-PLUGIN-004-positive:|TC-PLUGIN-003/004:`；之后诊断及组织授权各选择单一具名子用例。详细输出保留在本会话工具结果，未保存含真实业务数据的日志。

`plugin validate` 通过；`plugin check` 的深色登录、浅色登录、连接错误、考勤空态、待核实五个隔离场景通过，无 issue/warning。曾出现 Select 空 value 导致的 invalid options 警告，已改为显式 `all` 哨兵并复验。官方 loader 的 Node DEP0205 弃用提示不属于插件测试失败。

## 3. 真实登录发现与处置

1. 用户在实际面板提交 ONES 登录后出现回调错误；最初实现漏掉组织授权中间步骤。
2. 只读检查实例公开 `/auth/`、`/identity/` 脚本，确认 `organization_select?id=...` → `GET /identity/api/auth_request/{id}` → `POST /identity/api/auth_request/finalize` → `callback_url` → 最终回调的合同。
3. 按官方 `getFullIDSUrl` 为相对回调补 `/identity` 前缀，严格核对组织 scope；只访问同 origin 认证命名空间，最多一次 GET continuation，不自动追随任意重定向。最终 callback 路径与随机 state 仍需完全匹配。
4. 仅核对现有浏览器 Cookie 名称、域/路径/安全标志，未将浏览器令牌或 Cookie 导入插件。插件登录仍是独立账号密码认证。
5. HTTP/业务错误使用固定提示；后续现场错误现在可定位到认证步骤和 HTTP 状态码，不回传响应、密码、code 或 token。

修复后用户确认 ONES 登录成功，Worker 状态也回读连接成功。Coho 首次身份回读 HTTP 301 指向其它域名；按 TSD-COHO-001 补齐所有请求的 ATS 租户上下文后认证成功。未向其它域转发令牌。

真实只读补充：ONES 原完整列表达到 20 页上限而被阻断，改成显式按需分页后，前两页各 50 条且无重复身份，仍有下一页，不称为完整同步。2026-11-09 插件按本人身份读取 2026-11-06 的考勤与已有工时成功：2 条打卡、1 条已有工时，外勤为布尔类型、无跨日标志；未输出原始数据，不将该样本推广到全部日期。完整日工时仍使用完整分页，未为界面列表改动而放宽额度校验。

未验证验证码、MFA、密码过期等流程，不自动绕过。

## 4. 阻塞与恢复条件

| 范围 | 剩余工作 / 恢复条件 |
| --- | --- |
| 两站认证 | 正常路径已验证；高级认证、续期、宿主日志审计仍待验证 |
| 考勤读链路 | 单日本人读取与 ATS 身份链路已验证；跨期、缺卡/外勤等业务政策不擅自制定 |
| P1 工作项 | 完整元数据、详情正文与原单 URL 核实（已支持本地状态多选，非服务端筛选）；当前只提供标题级实施说明 |
| P2 提交 | 核对/恢复、补描述界面与定向负向证据已补齐；仍需批次部分成功等剩余风险及指定对象真实写入授权后的最小端到端验证，之后才评估开放生产写入 |
| P3 实施 | Orca 当前 Host API 无创建工作区，CLI 未提供方案要求的目标路径参数；需闭合受管路径、启动回执与恢复合同，不回退主目录执行 |
| P4 Bug 写入 | 动态 schema、权限、版本/并发、流转合同及授权对象未闭合，保持禁用 |
| UI 截图 | 已改用右侧真实面板直接 `plugin shot`，不传 `--scenario`、`--act` 或主题切换；成功截图见 §5。隔离场景仍未视觉验收，不要求用户最小化 |

自检已检查目标、权限、秘密生命周期、考勤前置、身份变化、写入未知态、DAG 与引用。回退仅停用开发插件并保留 Worktree；不删除凭证、草稿或用户数据，不进行未授权 Git 交付。


## 5. 增量验证记录

- 自动本人员工映射变更后：`TC-PLUGIN-003/004` 再次通过；随后精确执行 `TC-PLUGIN-003-self-attendance:|TC-PLUGIN-004-positive:|TC-PLUGIN-007-page:`，3/3 通过。不是全仓遍历。
- TypeScript 类型检查通过；分页 UI 更新后的三个 `plugin check` 场景通过，无 issue/warning。
- 源码/协议/测试与接口文档已同步；后续已补右侧真实面板截图，不以截图替代业务写入验收。

### 2026-11-09：记录核对与描述补全

- 精确选择 `TC-PLUGIN-004-recovery:|TC-PLUGIN-004-description:|TC-PLUGIN-007-recovery:|TC-PLUGIN-004: uncertain|TC-PLUGIN-004-positive:`，8/8 通过（6 个新增、2 个受影响回归）；上次结果因输出截断不可恢复，因此仅重跑此未知结果集合，未运行全量。
- 核对成功仅保存本地回执并使旧考勤预览失效；不会重新发送新增/描述 mutation。补描述只改变原描述；异常结果与新增共用账号/团队写入阻断。
- 本轮测试均为虚构 fixture；生产 `writesVerified: false` 未改变。类型检查通过、五个隔离渲染场景无 issue/warning。临时产物在本机 chat-scratch，不进入 Git；不是正式持久归档。

### 右侧真实面板截图与收口

- 重新加载返回 `already-approved`，权限仍为 trusted-worker、storage:own、secrets:own，无新增授权；右侧面板已打开。未重新输入密码，未触发真实新增/描述更新或 Bug 写入。
- 核对成功后的旧考勤预览失效与提示调整后，只重跑受影响面板恢复用例和密码生命周期用例，2/2 通过；TypeScript 检查通过。其它无变动风险复用上述证据。
- 用户操作期间 CUA 切页被并发保护拒绝，未强制覆盖。改为 CLI 直接捕获当时的考勤工时页，返回 `settled:true`、`errors:[]`、`pendingRequests:0`。这证明当前面板稳定呈现，不代表所有控件交互或业务写入通过。
- 截图来源：Orca 1.4.254 右侧真实运行面板，深色，460 × 1350；含本人考勤展示，仅保留本机临时目录，不入库。检查了认证状态、日期与打卡选择、手动分配和写入禁用提示。窄宽度下标签末端与下方内容需要滚动，尚未完成全尺寸、键盘与无障碍验收。
- [查看本机界面截图](</Users/choshim/Library/Application Support/orca/chat-scratch/7330a24ebd94185a9f48bb35ee55a1ff/ones-live-panel.png>)。这是临时缓存路径，可能被清理；没有将图片或原始考勤纳入 Git。
- 开发面板暂保持加载供用户继续查看，生产写入仍关闭；未提交、合并、推送或清理 Worktree。可按 plugin/README 的 dev unload 停止临时加载，不删除会话或草稿。

### 2026-11-09：Bug 列表默认状态筛选

- 用户指定“待处理”“重新打开”“修复中”默认选中，按 ONES 返回的状态名称精确匹配；状态和工作项类型分离，支持多选、全部状态、清空和恢复默认。项目/类型条件与状态条件取交集；切换身份或团队恢复默认并清除旧项目/类型条件。
- 不更改服务端查询或工时任务数据：只筛选已读取列表，后续页仍可加载；首屏无匹配不冒充全量为空。未执行写接口。
- 精确选择 `TC-PLUGIN-007-status:|TC-PLUGIN-007-page:`，2/2 通过；覆盖默认三项、取消/追加状态、全部/清空/恢复、首屏零匹配后追加命中页、工时任务选项不减少。TypeScript 检查通过。
- 右侧真实面板热更新截图 `settled:true`、`errors:[]`、`pendingRequests:0`，已目视确认三项默认勾选及独立项目/类型筛选；截图为空列表状态，不代替真实分页数据验证。来源 Orca 1.4.254，460 × 1350 深色。
- [查看状态筛选效果](</Users/choshim/Library/Application Support/orca/chat-scratch/7330a24ebd94185a9f48bb35ee55a1ff/ones-status-filter.png>)；本机临时文件可能被清理，不纳入 Git。

### 2026-11-09：紧凑状态标签选择框

- 用宿主 Box / Text / IconButton 组合选择框，标签有独立删除入口；右侧箭头展开或收起选项。展开区域支持状态多选、全部、清空及恢复默认。Orca 1.4.254 的原生 Select 仅支持单选，没有 MultiSelect/Popover，本实现是下方展开区域，不冒充原生浮层。
- 默认三种状态、筛选交集、分页与工时任务候选保持不变。复用现有 Worktree 与 ownership；自检补充空选择、删除全部标签、收起保持选择、重新添加不重复和多标签换行，不增加权限/依赖或改服务端接口。
- `TC-PLUGIN-007-status:|TC-PLUGIN-007-page:` 定向 2/2 通过；增加标签单删、重新添加、展开/收起保留选择及全部状态标签移除断言。TypeScript 通过；官方五场景渲染检查无 issue/warning，状态页自身亦由定向面板测试检查无 errors/warnings。
- 视觉判据：参照上方工作项类型选择框的宽度、主题边框和圆角；三枚默认标签文字完整，删除入口及右侧展开箭头可见、不相互遮挡，移除原常驻大块复选区域。
- 已打开检查 [真实面板截图](</Users/choshim/Library/Application Support/orca/chat-scratch/7330a24ebd94185a9f48bb35ee55a1ff/ones-status-tags.png>)：Orca 1.4.254，460 × 1350 深色，默认收起态满足上述判据；标签框稍高于单选框以容纳删除控件。截图返回 settled=true、errors=[]、pendingRequests=0。
- 视觉覆盖仅为上述尺寸/深色/默认收起态；展开态、浅色和大量长标签未取得视觉截图，不能将交互断言算作这些状态的视觉验收。截图为本机临时文件，可能被清理；不入 Git。未执行真实写入或 Git 交付。

### 2026-11-09：展开读取团队完整状态配置

- 原因：从已读取任务提取状态会漏掉尚无任务或后续页才出现的状态。改由 `tasks.statuses` → Workbench 身份/团队复核 → ONES `GET /task_statuses`；接口真源见 [TSD-ONES-001 §4.1.1](ones-api-integration.md#411-团队完整状态配置)。不修改任务查询、分页或写入闸。
- 所有任务页尚未读取也可取完整选项；默认三项及已选标签保留。失败不以默认项冒充完整配置，可显式重试；切换身份/团队清除旧列表；同名标签合并显示，过滤仍按名称，不擅自把配置解释成流转权限。
- UI 定向 `TC-PLUGIN-007-status:|TC-PLUGIN-007-status-catalog:` 2/2：未出现在任何任务页的状态可选择，删除/重加/分页不变量保持，失败提示与重试、切换团队清旧数据通过。服务定向 `TC-PLUGIN-002-statuses:` 3/3：独立读取 77 个虚构状态、不请求任务页、重复 UUID/畸形配置拒绝、登录失效/读取期间身份变化拒绝。TypeScript 通过。
- 真实 Worker 桥接只读验证：当前唯一团队返回 77 条、77 个唯一 UUID，76 个唯一名称；生产 writeEnabled=false。不重复登录，不读取密码，无真实业务写入；配置名称和数量是本次样本，不硬编码进实现。
- 用户已确认右侧出现完整状态列表。CUA 自动点击被并发保护拒绝后，由用户展开，随后官方 CLI 直接截图；未强行操作窗口。
- 已实际打开检查 [展开态截图](</Users/choshim/Library/Application Support/orca/chat-scratch/7330a24ebd94185a9f48bb35ee55a1ff/ones-status-catalog-expanded.png>)：Orca 1.4.254，460 × 1350 深色；三枚默认标签与收起箭头完整，选项面板和字段等宽，刷新、全部状态、恢复默认、清空入口可见；选项区限高滚动，底部滚动边界裁切属于视口边界，未覆盖操作按钮。此尺寸/外观的展开态布局通过，浅色、其它尺寸与键盘滚动未补验。
- 截图返回 settled=true、errors=[]、pendingRequests=0；截图不能证明滚动后所有选项逐项交互正确，完整数量来自真实接口证据，选择行为由定向测试覆盖。文件仅在本机临时目录，可能被清理；未入 Git。

### 2026-11-09：仅查缺陷，状态限定缺陷类型

- 前一版本“我的 Bug”查询所有本人工作项、展示全部团队状态，属于范围错误。以上团队全集截图与旧用例保留为历史证据，不代表用户本次要求已验收。
- 按类型元数据唯一解析内置缺陷 UUID，`bugs.list` 首/续页强制本人 + 缺陷 ID，回读拒绝任何非缺陷；`bugs.statuses` 仅返回缺陷类型默认状态引用。类型不明、配置缺失或重复时停止，不回退全部任务或全部团队状态。
- Bug 和工时任务各自持有数据、游标和去重集合；工作项类型控件固定显示“缺陷”。工时页的 `tasks.list` 保持不限定类型；读取工时任务不会覆盖 Bug 列表，读取 Bug 不会填充工时候选。
- 定向选择 `TC-PLUGIN-002-statuses:|TC-PLUGIN-002-bugs:|TC-PLUGIN-007-page:|TC-PLUGIN-007-status:|TC-PLUGIN-007-status-catalog:`，7/7 通过；覆盖服务端必要过滤、后续页、错类型回包拒绝、缺失/歧义配置拒绝、跨站身份变化、列表隔离后继续读取普通任务与原 Bug 保留。TypeScript 通过；不运行全仓测试。
- 同源浏览器只读核实缺陷默认配置 7 项，详情见 TSD-ONES-001 §4.1.1。没有将浏览器令牌导入插件。插件现场复验因自身 ONES 会话处于未登录状态而暂停，已请用户在插件重新登录；此时尚不标记修复后插件真实查询或展开视觉通过。

### 2026-11-09：移除冗余类型控件并补齐缺陷接口实测

- 按用户要求移除“Bug / 工作项类型”（上一版显示“工作项类型”）选择框；服务端只查缺陷的限制保持不变，项目/状态筛选和工时独立任务查询均保留。
- 复用同一任务 Worktree、基线与 ownership。仅修改面板单项展示、相关断言及说明；视觉判据为移除后项目和状态选择框直接衔接，无遗留空白或标签遮挡，不重跑无关业务测试。
- 定向 `TC-PLUGIN-007-status:` 1/1 通过，新增两个旧标签均不存在断言，仍覆盖状态选择、分页及工时任务隔离；TypeScript 通过。
- 已打开检查 [移除后实际面板截图](</Users/choshim/Library/Application Support/orca/chat-scratch/7330a24ebd94185a9f48bb35ee55a1ff/ones-without-type-filter.png>)：Orca 1.4.254，460 × 1350 深色；项目与状态框间距正常，类型控件消失，默认三个标签完整，当前无任务的空态没有遮挡。截图 settled=true、errors=[]、pendingRequests=0。文件在本机临时目录，可能被清理，不纳入 Git。
- 截图显示 ONES 已重新认证，遂通过开发 Worker 补齐上一阶段受阻的真实只读验证：`bugs.statuses` 返回缺陷 7 项；`bugs.list` 首屏返回 50 条，类型全部为缺陷，仍有下一页，不声称已经读完全部 Bug。未输出任务标题/真实 ID、未调用写接口；没有复用浏览器凭证。Coho 当前未登录不影响这两项 ONES 读取。
- 本轮视觉证据覆盖移除控件后的默认收起态，缺陷七状态展开态仍未截图，不复用之前团队 77 项的展开截图冒充。

### 2026-11-09：隐藏 Bug 团队项、进入自动刷新

- 团队入口从 Bug 页移除，多团队可在登录页选择；单团队沿用当前账号团队，多团队首次不默选。首次挂载/切回自动读第一页，手动按钮改为“刷新缺陷”；保留项目/状态选择，工时列表和已存草稿不因 Bug 刷新被清空。
- 独立 bugGeneration/AbortController 隔离异步读取：离页、切团队、卸载取消旧读，旧响应和旧 finally 不能覆盖新页面。刷新先清旧列表与游标；失败明确提示，异常续页不标为分页完成。
- 定向 `TC-PLUGIN-007-auto:|TC-PLUGIN-007-page:|TC-PLUGIN-007-status:|TC-PLUGIN-007-status-catalog:|TC-PLUGIN-007: login` 7/7 通过；之后仅补跑新增异常续页用例 1/1 通过。TypeScript 初次发现测试 deferred Promise 类型不匹配，改为 Answer<TaskPage> 后通过，不放宽类型检查。
- 真实右侧面板自动读取首屏 50 条缺陷，默认三状态显示 9 条，仍有下一页；没有点击手动读取或调用写接口。首张截图捕获初始化过渡态，不作为最终通过证据。
- 已打开检查 [就绪态实际截图](</Users/choshim/Library/Application Support/orca/chat-scratch/7330a24ebd94185a9f48bb35ee55a1ff/ones-bug-auto-refresh-ready.png>)：Orca 1.4.254、460 × 1350、深色；团队控件消失，刷新按钮、项目/状态选择布局正常，列表/部分加载提示和加载更多入口可见。长标题使用省略显示；截图保留当时面板滚动位置，非全内容长图，不证明完整文字或全部状态可访问。
- 截图 settled=true、errors=[]、pendingRequests=0；包含本机真实缺陷展示，仅存 chat-scratch，可能被清理，不纳入 Git。浅色、多尺寸与键盘行为未新增视觉验收；接口/业务只读边界不变，未提交、合并或推送。


### 2026-11-09：完整 Bug 详情与隔离宿主内嵌媒体

**判定：本机开发扩展完成实现并通过限定验证；不是已安装 Orca 的升级，也不是整个插件方案生产验收通过。** 两仓 worktree、官方独立基线及 ownership 见规划 §9；主工作区、已安装应用保持原样。未提交、合并或推送，无 ONES mutation、真实工时操作或 Agent 启动。验证曾注册隔离 profile 的空文件夹上下文，仅用于隐藏右侧面板，不是业务实施工作区。

#### 实现与定向证据

| 范围 | 证据 / 结论 |
| --- | --- |
| 内容解析 | `bug-content.test.ts` 3/3；不执行 HTML，不传任意 URL，文字/媒体顺序与拒绝结构上限 |
| 详情与分页 | `bug-details.test.ts` 3/3；正文身份、包含边界分页、未知类型和无进展失败；系统事件先与 discussion 分离 |
| ONES 媒体 | `bug-media.test.ts` 3/3；限定 origin/资源、MIME/大小、分块、关闭会话和取消，不转发 Bearer 到签名资源 |
| 服务生命周期 | `bug-detail-service.test.ts` 最终 5/5；新详情撤销旧 handle、退出/迟到/旧 close、待完成请求关闭、碎片内容超出宿主容量拒绝 |
| 面板 | 新宿主 native + pending leave 2/2；旧宿主 legacy 1/1；额外长正文 1/1（24,000 字符全部保留且末尾可见，无 errors/warnings）；评论前后翻页和只读按钮保持 |
| 受影响旧流程 | 精确选择 login 与 auto initial/reentry 2/2；密码清理、离页后 Bug 自动重读保持 |
| 宿主 | `plugin-declarative-media-loader.test.ts` 4/4、schema 1/1；URL/MIME/尺寸/分块拒绝、取消迟到、图像尺寸边界及 URL 释放；未运行全仓测试 |
| 静态与构建 | ONES TypeScript 通过；宿主 renderer TypeScript、目标 lint、electron-vite build 通过；生成 runtime/types 同步，未改变 HTML CSP 或网络权限 |

真实接口与媒体样本：插件自身会话只读取得 Bug 正文和 1 条用户评论；另一含图片样本返回 5 个内容块、1 条评论，JPEG 372,333 字节经签名地址读取为 1 块。初次因系统消息 `ref_type=project` 误判失败，修复后真实读取通过。仅打印脱敏计数，没有保存原始正文、资源 URL、签名或令牌。实际多页评论、非空独立附件、真实 ONES 视频与 MP4 解码仍未验证。

#### 隐藏 Electron 行为与视觉证据

环境：macOS 27.2 / arm64，官方 v1.4.254 独立分支，Electron 43.8.6；`ORCA_BACKGROUND_LAUNCH=1`、隔离 HOME/userData、遥测关闭。实际右侧原生面板 → 主进程批准状态/session → 本插件 Worker → bytes → Blob URL，不是 HTML mock 图片或静态 replay；仅外部 ONES 数据由虚构 Worker fixture 替代。未最小化、切换、显示或聚焦用户窗口。

- PNG 640×360 解码成功；WebM/VP8 640×360 初始 paused=true / autoplay=false，播放时间实际推进，暂停及定位到 0.6 秒通过；离页后 img/video 移除，两条 Blob URL 均不可再读取。此证据不代表真实 ONES 视频、所有 codec 或远端宿主均通过。
- 主面板深浅色均为 460×1350，官方 shot 返回 settled=true、errors=[]、pendingRequests=0。已实际打开图片检查：正文换行、图片比例、视频控件、末尾文字及评论完整，无相互遮挡。底部附件在滚动视口外，不声称这张图覆盖全部页面；顶部 Tabs 使用现有横向滚动样式，右侧登录项部分在视口外。
- 加载态按钮禁用且中文提示完整；不支持 MIME 被拒绝，显示原单回退提示和重试按钮，不输出上游细节。对应截图已打开检查；错误截图右缘含宿主浮动控件边缘，未遮挡错误文字或重试按钮。
- 隔离驱动早期发生无工作区、错误控件选择器和文案路径错误；已修复驱动/文案后完成最终流程。早期 shutdown helper 的 unref timer 令 Node 在清理期间退出，最终驱动添加 keepalive 并使用仓库既有 scoped cleanup，最终退出码 0。失败截图/日志不计作通过证据。

截图均为本机隐藏 Electron、虚构数据，文件位于临时 chat-scratch，可能被清理，不纳入 Git：

- [浅色完整详情](</Users/choshim/Library/Application Support/orca/chat-scratch/7330a24ebd94185a9f48bb35ee55a1ff/ones-inline-media-light.png>)
- [深色完整详情](</Users/choshim/Library/Application Support/orca/chat-scratch/7330a24ebd94185a9f48bb35ee55a1ff/ones-inline-media-dark.png>)
- [媒体加载态](</Users/choshim/Library/Application Support/orca/chat-scratch/7330a24ebd94185a9f48bb35ee55a1ff/ones-inline-media-loading.png>)
- [不支持格式提示](</Users/choshim/Library/Application Support/orca/chat-scratch/7330a24ebd94185a9f48bb35ee55a1ff/ones-inline-media-error.png>)

行为证据：同目录 `ones-inline-media-evidence.json`；可复现驱动 `verify-inline-media.mts`。最终源码身份分别记录为 `ones-plugin-inline-media-identity.json`、`orca-plugin-inline-media-identity.json`。目录中 fixture 只含虚构数据，但不是发布包内容；保留 worktree 供后续检查，未安装替换开发宿主。

#### 剩余边界

正文保留文字、顺序与换行，不还原任意 HTML/表格样式、链接或扩展节点；超出完整视图预算明确失败，不能声称任意大小的详情都可内嵌。图片 4096 边长、格式及 32 MiB 单文件上限见开发说明。Worker 会话超时后拒绝读取，正常关闭会清缓存；宿主 RPC 没有网络级取消，异常终止插件面板不保证 Worker 在同一时刻回收，缓存仍受单视图预算限制。Windows/Linux、远端 Worker、Web/mobile 及真实视频样本待补；这是该历史阶段的结论；随后已改为下述仅插件方案，无需运行或安装开发宿主。


### 2026-11-09：仅插件 HTML 面板（最终展示路线）

**本轮插件内嵌媒体与展示层迁移通过本机限定验收；无需修改 Orca。** 正式入口 `src/panel.html`、`src/html/`，原 Worker、认证与写入闸门不变。旧 native UI 已归档到本机 scratch，不保留双实现。先前把 web/srcdoc 的媒体限制误用于桌面 HTML guest，已纠正；实际安装包及运行中 guest 的 CSP 含 `media-src 'self' data: blob:`，没有放宽宿主策略。

- 测试宿主：未修改 `/Applications/Orca.app` 1.4.254，packaged=true；隔离 HOME/userData、`ORCA_BACKGROUND_LAUNCH=1`、隐藏窗口。只替换 fixture Worker，数据完全虚构；未最小化、重启或切换用户窗口。隐藏实例及其 daemon 已按 profile 清理。
- `html-media.test.ts` 3/3：有效字节/撤销、恶意或不一致分块与 MIME/尺寸拒绝、取消后迟到不发布。未运行全仓或全插件测试。
- `html-panel.browser.mjs` 的同一有界旅程通过：默认三状态/完整选项与删除标签；正文安全文本而非脚本；PNG 解码、WebM 初始暂停/禁止自动播放、播放推进、暂停及 0.6 秒定位；评论前后翻页；错误附件；离页 img/video 移除且 Blob 无法再读取。返回评论第一页曾因传入 `before: undefined` 被严格 JSON 桥拒绝，现改为省略该字段并实测通过。
- 同旅程覆盖迁移影响面：无考勤/映射不可分配，普通任务仍可选，打卡人工核对，非空描述的手动预览，跨标签草稿保持、日期变化失效、恢复后重读；核对歧义无确认入口，提交/补描述禁用；密码遮罩、提交/离页清空，重新认证清业务草稿，退出清 Bug，重入自动刷新。fixture 调用清单无工时提交/补描述/恢复确认。
- 严格 TypeScript 7.0.2 及 `plugin validate` 通过。使用本机 Orca checkout 的编译器与 `@types/node`，`--preserveSymlinks false` 保证 pnpm 包按真实位置找到匹配 undici-types；未跳过类型检查。最初误用不存在的插件本地编译器及保留符号链接时依赖类型检查失败，不计作通过。
- 真正用户右侧已 `dev reload` + `open`：already-approved、running、无新增权限；两站 connected=true、writeEnabled=false。实际截图自动读取 50 条缺陷，默认筛选显示 7 条，仍有下一页。未读取密码、未调用业务写接口。

#### 视觉验收与复现

实际打开检查深浅色 460×1350、窄屏 360×1350，以及加载、错误、考勤预览、登录和筛选截图：标题/文字换行、媒体比例与控件、评论翻页、标签删除入口可见，无横向溢出或控件遮挡；长页面通过滚动查看，并非单张图覆盖全页。真实右侧为 882×1350 深色，列表加载完成、状态标签/标题/导航正常。所有 shot settled=true、errors=[]；HTML 的 settled 不代表业务响应完成，本轮另有旅程等待断言与实际截图检查。

本机证据目录：`/Users/choshim/Library/Application Support/orca/chat-scratch/7330a24ebd94185a9f48bb35ee55a1ff`（临时目录，可能被清理，不纳入 Git）。

- [浅色详情](</Users/choshim/Library/Application Support/orca/chat-scratch/7330a24ebd94185a9f48bb35ee55a1ff/ones-html-detail-light.png>) / [深色详情](</Users/choshim/Library/Application Support/orca/chat-scratch/7330a24ebd94185a9f48bb35ee55a1ff/ones-html-detail-dark.png>) / [窄屏](</Users/choshim/Library/Application Support/orca/chat-scratch/7330a24ebd94185a9f48bb35ee55a1ff/ones-html-detail-narrow.png>)
- [加载](</Users/choshim/Library/Application Support/orca/chat-scratch/7330a24ebd94185a9f48bb35ee55a1ff/ones-html-loading.png>) / [错误附件](</Users/choshim/Library/Application Support/orca/chat-scratch/7330a24ebd94185a9f48bb35ee55a1ff/ones-html-error.png>) / [考勤预览与写闸](</Users/choshim/Library/Application Support/orca/chat-scratch/7330a24ebd94185a9f48bb35ee55a1ff/ones-html-hours-preview.png>)
- [真实右侧开发预览](</Users/choshim/Library/Application Support/orca/chat-scratch/7330a24ebd94185a9f48bb35ee55a1ff/ones-html-live-sidebar.png>)：本机真实缺陷展示，不是虚构数据或视频验证。

`ones-html-evidence.json` 为隐藏安装版运行身份、CSP、旅程与截图结果；`verify-html-panel.mts` 为本机驱动，复用只读 Orca checkout 的 Playwright/Electron 隔离及清理 helpers，不构建或运行开发宿主。源码中的 `tests/fixtures/fixture-assets.json` 仅含已检查的虚构 PNG/WebM（640×360），必须连同 `html-worker.ts` 放入隔离 fixture 的 `src/`，不能载入真实 profile 替换业务 Worker。类型命令（TOOLING 为本机已安装开发依赖目录，不自动下载）：

```sh
"$TOOLING/node_modules/.bin/tsc" -p plugin --preserveSymlinks false \
  --typeRoots "./plugin/.orca/types,$TOOLING/node_modules/@types"
```

HTML 迁移阶段源码身份见同目录 `ones-plugin-html-media-identity.json`。只有表现层与说明变更；真实 ONES JPEG 只读链路复用前阶段未变 Worker 的证据，实际 ONES 视频、MP4/更多 codec、非空真实附件和多页评论仍未验证。键盘/无障碍完整验收、跨平台与远端模式也未完成。没有提交、合并、推送或清理任务分支；宿主开发分支保留但不参与插件运行。


### 列表整行进入详情

- 仅调整 `src/html/panel.ts`、`panel.css` 的列表入口：移除两按钮，右侧装饰性 chevron；整行使用原生 button，无嵌套交互控件，保留标题换行和键盘焦点样式。详情仍可打开原单；Worker 与写闸未变。
- `exerciseBugRows` 在未修改 Orca 1.4.254 隐藏隔离实例通过：旧按钮不存在；点击标题、箭头、整行分别进入对应详情；返回自动重读；无认证、工时或 Bug 写操作。严格 TypeScript 通过，未重跑无关的完整旅程或全量测试。
- 已实际打开检查 460px 深浅色、360px 窄屏截图：箭头右侧居中、标题完整换行，未见遮挡或横向溢出。已 reload/open 用户右侧开发预览。
- [浅色列表](</Users/choshim/Library/Application Support/orca/chat-scratch/7330a24ebd94185a9f48bb35ee55a1ff/ones-bug-row-light.png>) / [深色列表](</Users/choshim/Library/Application Support/orca/chat-scratch/7330a24ebd94185a9f48bb35ee55a1ff/ones-bug-row-dark.png>) / [窄屏列表](</Users/choshim/Library/Application Support/orca/chat-scratch/7330a24ebd94185a9f48bb35ee55a1ff/ones-bug-row-narrow.png>)；均为安装版 Orca 隔离实例中的虚构素材，不是业务写入证据。文件位于本机临时 chat-scratch，可能被清理。
- 同目录 `ones-bug-row-evidence.json`、`verify-bug-rows.mts` 为定向旅程及驱动，最终源码身份为 `ones-plugin-bug-row-identity.json`。本轮复用任务分支，不提交、合并或推送。
