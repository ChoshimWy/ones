---
document_id: VR-ONES-PLUGIN-001
document_type: verification-report
version: "0.6.0"
status: draft
owner: "Main：实施与定向验证"
related_requirements: ["REQ-ONES-001", "REQ-ONES-002", "REQ-ONES-003", "REQ-ONES-004"]
related_documents: ["IMP-ONES-PLUGIN-001: orca-plugin-plan.md", "TSD-ONES-001: ones-api-integration.md", "TSD-COHO-001: coho-attendance-api.md"]
updated_at: "2026-11-10"
source_identity: "本次文档基线 main@cc0cdfb8e1335e72ca2eaf894c8855010e94b801；EV-ONES-006 不属于插件执行；历史实施 main@59f1225d439e15cb912b13e959f453e54044d109 + feat/bug-repair-session；最终未提交身份见本机 chat-scratch/f653ebe6031d929d0fa28d15e32aac18/ones-repair-source-identity.json；历史证据身份仅适用于对应章节"
evidence: ["EV-PLUGIN-002: 本会话定向 runner 结果", "EV-PLUGIN-003: Orca plugin validate/check 结果", "EV-PLUGIN-004: Orca dev load/open/status 与真实登录现场", "EV-ONES-006: ones-api-integration.md §8.1；非插件运行证据"]
---

# ONES 工作台：阶段验证报告

## 1. 判定与环境

**完整方案验收不通过；开发原型部分完成。** 不能将虚构 fixture 的提交成功写成真实工时成功。生产 Worker 固定 `writesVerified: false`，没有可绕过的 UI 设置；该初始验证阶段未修改真实工时、Bug、工作区或启动 Agent。后续 CLI 阶段证据见对应章节；2026-11-10 单笔 API 状态写入见文末，不能计为插件写入已通过。

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


### CLI 修复聊天阶段（2026-11-09）

本阶段按 IMP-ONES-PLUGIN-001 第 11 节实施，沿用已安装 Orca 1.4.254（macOS、Node 26.0.0），未修改宿主。代码位于 `feat/bug-repair-session` 隔离 Worktree；未提交、合并或推送。既有阶段通过项不等于本次真实启动通过。

| 验证 | 实际结果与边界 |
| --- | --- |
| TC-PLUGIN-CLI-001 映射 | 5 个新定向用例通过：空格/大小写/全角/尾标记、歧义拒绝、稳定 ID、删除目标不静默重绑、重复身份拒绝 |
| TC-PLUGIN-CLI-002 内容 | 2 个新定向用例通过：分页含空页、重叠一致性、游标停滞、完整正文顺序与评论、媒体引用、缺失/不支持/超限拒绝 |
| TC-PLUGIN-CLI-003 启动 | 9 个新定向用例通过：本地主目录限定、argv 不经 shell、真实回执结构、媒体失败清理、账号变化、跨 Worker 防重、重启/超时不重发；CLI 启动由 fixture 替身，非真实 Agent 执行 |
| TC-PLUGIN-CLI-004 权威数据 | 1 个服务用例通过：通过真实 Workbench 方法重新只读获取内容、校验原身份，退出登录撤销后续操作 |
| 静态 | TypeScript 与 `plugin validate` 通过；没有全仓测试、跳过检查或新增 runtime 权限 |
| CLI 现场只读 | 用本次 OrcaCli 适配器解析真实 SidusLinkPro，确认唯一就绪本机 setup 与已有主目录 selector；未创建工作区或启动 Agent |
| UI | 未修改的安装版 Orca 隐藏隔离 profile，虚构 Bug/媒体/启动回执；双入口、顶行靠右、自动映射、手动回退（未选目标禁用发送）与回执提示已通过；视觉证据为 guest 原位截图，深浅色使用 fixture theme tokens，不冒称真实用户主题 |
| 真实启动 | NOT_RUN：真实 Ones 项目联调会话启动被安全审批阻止，未执行 CLI 启动；需要用户单独允许创建测试 session。真实 Bug 修复、媒体在目标 Agent 中读取/解码、真实多账号/多窗口、远端与其它平台未验证 |

截至本阶段，共 17 个不同的新风险用例通过；后续改动只复验受影响 CLI/启动用例，复用未变映射、内容及服务证据。首次错误的 Node transform flag/strip-only 方式因既有 parameter properties 不兼容，改用安装版官方 loader；一次同步异常误用异步断言已修正复验，均不作为通过证据。

截图驱动发现 `plugin shot` 会重新打开 HTML 面板导致当前详情丢失，因此不用它的空白/列表图作详情证据；改用同一 guest 的原位 capturePage。隐藏 guest 的渲染等待曾挂起，已精确结束本次测试实例并为驱动增加 deadline；不改产品代码绕过。真实开发预览加载也被安全审批阻止，用户当前窗口未切换到此任务源码，需要单独授权加载。已查看有效深浅色与窄屏图：顶行按钮分居两侧，表单/提示换行正常，无横向溢出或遮挡；单张截图不能代表全部长页面或 Agent 执行通过。

EV-PLUGIN-CLI-001 本机证据目录：`/Users/choshim/Library/Application Support/orca/chat-scratch/f653ebe6031d929d0fa28d15e32aac18`（临时缓存，可能被清理，不纳入 Git）。
- [自动匹配确认](</Users/choshim/Library/Application Support/orca/chat-scratch/f653ebe6031d929d0fa28d15e32aac18/ones-repair-confirm.png>)、[窄屏](</Users/choshim/Library/Application Support/orca/chat-scratch/f653ebe6031d929d0fa28d15e32aac18/ones-repair-narrow.png>)、[会话结果](</Users/choshim/Library/Application Support/orca/chat-scratch/f653ebe6031d929d0fa28d15e32aac18/ones-repair-receipt.png>)。
- [底部入口](</Users/choshim/Library/Application Support/orca/chat-scratch/f653ebe6031d929d0fa28d15e32aac18/ones-repair-footer.png>)、[手动映射](</Users/choshim/Library/Application Support/orca/chat-scratch/f653ebe6031d929d0fa28d15e32aac18/ones-repair-manual.png>)：同一安装版 guest 的虚构内容；底部滚动到位、按钮可见且靠右，已实际查看。
- `ones-repair-evidence.json`、`verify-repair-panel.mts`：隐藏安装版身份、定向交互旅程和截图记录；fixture worker 中的 session 是明确的虚构值，不是真实创建证明。

尚未开放直接跳转指定 session、完成后的重新发起及未知启动的自动恢复；在原项目手动核实。安全模型与资料保留见插件 README，不把 0600 权限称作加密。文档自检已完成：身份、旧方案替代关系、真实/fixture 证据与剩余风险分开记录。

### 当前项目跟随筛选（2026-11-09）

- Main 在 §11 相同任务 Worktree 内实现，新增 `workspace:read`；真实用户插件尚未加载此源码/授权新增权限。未修改 Orca，未启动真实聊天，未提交、合并或推送。
- 8 个不同的 `project follow` 定向测试通过：工作区所属项目而非 cwd/显示名、空/歧义/截断/权限错误、切换中旧结果、稳定 ID selector、名称与显式反向映射、账号隔离，以及同名 main 的终端 ID 归属消歧。补充远端/缺失/跨归属拒绝后仅重跑该用例通过。共享 mapping key 的既有映射/修复持久化定向用例复验通过。严格 TypeScript 与 `plugin validate` 通过，未跑全量测试。
- `project-follow.browser.mjs`：未修改的安装版 Orca 1.4.254、隐藏隔离 HOME/profile、3 个虚构 Git 项目（主分支均为 main），使用真实原生侧栏选择、宿主事件及 Worker CLI，只替换 ONES 数据。SidusLinkPro 自动匹配、第二项目切换、无匹配显示全部、手动筛选刷新保留、下一项目恢复跟随、受控旧响应延迟释放不覆盖新选择、状态筛选保持全部通过。补充旅程实际新增同项目 fixture 终端，手动筛选仍保留，再切项目恢复跟随。没有调用 Agent launch、ONES mutation 或真实账号。
- 诊断发现普通文件夹 fixture 的宿主 context 为 null，按合同回退全部；多个 main 同名需终端 ID 消歧，不能只按名字。隔离 Worker 会清理 `ORCA_*` 路由变量，驱动在隔离 HOME 内把标准 profile 路径指向同一测试目录后验证 CLI；未指向真实 profile。隐藏 guest 计时器节流导致等待超时，改为驱动有界轮询后通过；前述失败不计通过证据。
- 已实际打开检查 460px 深色匹配和 360px 浅色回退截图：项目选择及跟随提示正确，长提示正常换行，状态标签与缺陷列表完整，无横向溢出、遮挡或截断。使用 fixture 主题与虚构数据，不是真实账户上线验收；截图不代表会话执行通过。

EV-PLUGIN-FOLLOW-001 与 CLI 阶段使用同一临时证据目录（可能被清理）：`/Users/choshim/Library/Application Support/orca/chat-scratch/f653ebe6031d929d0fa28d15e32aac18`。
- [SidusLinkPro 自动匹配](</Users/choshim/Library/Application Support/orca/chat-scratch/f653ebe6031d929d0fa28d15e32aac18/ones-project-follow-sidus.png>)
- [无匹配回退全部](</Users/choshim/Library/Application Support/orca/chat-scratch/f653ebe6031d929d0fa28d15e32aac18/ones-project-follow-all.png>)
- `ones-project-follow-evidence.json` / `ones-project-follow-terminal-evidence.json`：运行身份和行为结果；`verify-project-follow.mts` / `verify-project-follow-terminal.mts`：本机驱动；`ones-project-follow-source-identity.json`：收口源码身份。生产源码在两段 UI 旅程及最终类型检查间未变，最后仅补充负向测试和文档。
- 边界：筛选仍限已读取本人缺陷；没有匹配项目的缺陷尚未加载时显示全部，续页后重匹配。无上下文/无终端且同名歧义、其它 Orca 版本、多窗口/远端与真实账号项目切换未验证。原 CLI 修复聊天的真实启动/媒体消费 NOT_RUN 保持不变，不能用本轮只读筛选验证替代。


## 状态更新接口证据与 UI 规划（2026-11-10，历史规划阶段）

- 单笔真实接口结果：引用 [EV-ONES-006](ones-api-integration.md#ev-ones-006单笔状态流转2026-11-10)，用户授权后通过同源 HTTP API 完成修复状态、根因、解决版本及评论提交并回读一致；异步查询返回 `none`，不是后置动作完成证据。未通过插件或网页表单提交。
- 插件结论：状态更新操作尚未实现，现有写闸未改变；不把接口样本成功扩展为插件认证、动态字段、权限/竞态、未知结果恢复或 UI 验收通过。
- 待执行项：详见 [规划 §13](orca-plugin-plan.md#bug-status-update) 的 TASK-PLUGIN-100–103 与 TC-PLUGIN-STATUS-001–004，均未实施/NOT_RUN。会话总结自动读取未实现，不作为首期手动粘贴的前置条件。
- 本轮只改文档；复用本会话提交与回读回执，不重放业务写请求、不运行插件测试。未新增可视内容，未生成 UI 验证截图；实施时由 Main 按规划补齐真实渲染截图并实际查看。


## 状态更新实现阶段（2026-11-10，初次验证快照，未发布）

- 身份：`main@cc0cdfb8e1335e72ca2eaf894c8855010e94b801` → `feat/bug-status-update`，Worktree `/Users/choshim/.agent-worktrees/choshimwy-ones/feat/bug-status-update`；单 Builder 实施，Main 接口补证。所有改动未提交，未改主工作区或其它仓。
- `status-update.test.ts`：9 个定向测试通过；覆盖动态字段/权限与转义、双击单次请求、账本失败零写入、详情/配置漂移、身份失效、403/5xx/丢响应/200 后回读失败、重启未知不重发、跨 Worker 锁、评论 UUID/作者/富文本核对、崩溃锁只读核对、历史保留及真实 Workbench 的详情/评论/列表/修复上下文刷新链。全部使用虚构 fetcher，不是真实 ONES 写入证据。
- 静态：严格 TypeScript 检查通过；`git diff --check` 通过。未运行全仓/全插件测试。
- UI：已编写 `status-update.browser.mjs` 有界旅程，但安装版 Orca 1.4.255 隐藏隔离 profile 的 fixture 首次加载遇到 `approval_required`；未自动批准、未触及真实 profile。当前无有效 UI 截图，不能标记视觉或交互通过。恢复条件：用户批准该 fixture 的同范围 trusted-worker / storage:own / secrets:own / workspace:read 权限。
- 正式 `StatusWorkflow` 写闸默认 false，现有 `writesVerified:false`（工时）不变；真实插件登录到单次提交/回读端到端 NOT_RUN。真实样本或一次 API 手工成功不能替代插件路径；不从浏览器提取 token 注入测试。
- 限制：只支持已核实空条件/触发器/后置动作的单选、文本及评论步骤；未知配置 fail closed。磁盘目录 0700、文件 0600 不等于加密；崩溃残留锁不会自动释放，允许只读核对但新提交需人工核实本机状态。只有状态/字段/评论全部一致才标记成功，异步 `none` 仍单独标为后置未确认。

定向复现（使用本机已安装 loader，不自动下载工具）：

```sh
node --import /Applications/Orca.app/Contents/Resources/app.asar.unpacked/resources/plugins/declarative/orca-test-register.mjs --test plugin/tests/status-update.test.ts
"$TOOLING/node_modules/.bin/tsc" -p plugin --preserveSymlinks false --typeRoots "./plugin/.orca/types,$TOOLING/node_modules/@types"
```

最小回退为保持状态写闸关闭、撤销本次状态入口/handler wiring；保留账本用于核对，不撤销远端已生效状态或删除评论，不删除既有修复聊天。


### 状态 UI 验收续记与受控 E2E 准备

用户已明确授权本次隔离 fixture 和正式插件的既有同范围权限。安装版 Orca **1.4.255**、macOS、隐藏隔离 HOME/profile；虚构数据 Worker，不使用真实凭证。原截图驱动因隐藏 guest 捕获等待触发 deadline，未计作通过；仅将驱动改为 Electron 支持的 `stayHidden/stayAwake` 捕获及有界等待后完成验证，未放宽产品检查。

- `status-update.browser.mjs` 主旅程 PASS：必填根因错误、总结粘贴/转义、完整字段与评论预览、提交期间控件禁用、unknown 重开禁止重发、核对成功后详情/评论/列表权威刷新与筛选移除、修复记录保留。fixture 状态 Submit 和 repair.start 均只有 1 次。
- 新增 comment-only 定向测试 1/1 PASS：无字段步骤提交空 field_values，保留已有字段并按自身评论确认。结合此前未失效的 9 项证据，共 10 个状态风险用例；没有执行全量测试。
- 收起状态表单时补齐焦点回到“更新状态”；仅补跑键盘旅程 PASS：展开聚焦原生 select、收起回焦、真实 Tab 到“执行修复”。此局部焦点改动不改变此前截图布局，复用主旅程视觉证据。
- 实际打开检查全部 8 张截图：360/460px 深浅色，必填标签、错误、长总结换行、预览确认按钮、提交禁用、unknown/success 结果与评论可见，无横向溢出或控件遮挡。textarea 内长内容可滚动，完整评论在预览显示；单张图不覆盖整页。`none` 始终注明后置动作未证明完成。

本机证据目录（临时 chat-scratch，可能被清理，不纳入 Git）：
`/Users/choshim/Library/Application Support/orca/chat-scratch/8f900a07ed408984d279644035c82856`

- [表单深色](</Users/choshim/Library/Application Support/orca/chat-scratch/8f900a07ed408984d279644035c82856/ones-status-form-dark.png>) / [窄屏完整预览](</Users/choshim/Library/Application Support/orca/chat-scratch/8f900a07ed408984d279644035c82856/ones-status-preview-light.png>)
- [待核实](</Users/choshim/Library/Application Support/orca/chat-scratch/8f900a07ed408984d279644035c82856/ones-status-unknown.png>) / [更新成功](</Users/choshim/Library/Application Support/orca/chat-scratch/8f900a07ed408984d279644035c82856/ones-status-success.png>)
- [评论刷新](</Users/choshim/Library/Application Support/orca/chat-scratch/8f900a07ed408984d279644035c82856/ones-status-comment.png>) / [焦点回退](</Users/choshim/Library/Application Support/orca/chat-scratch/8f900a07ed408984d279644035c82856/ones-status-focus-return.png>)
- `ones-status-evidence.json`、`ones-status-keyboard-evidence.json`：运行身份、旅程与截图清单；`verify-status-panel.mts`、`verify-status-keyboard.mts`：本机驱动。

**受控验证结果**：Main 已完成本次指定样本正式 Worker 两步提交与独立回读，保留状态 gate true；工时 `writesVerified:false` 不变。Builder 不发送 mutation。此验证不是正式发布或全部方案验收，详细边界见下节。


### 正式 Worker 两步实写收口（2026-11-10）

接口真源 [EV-ONES-008](ones-api-integration.md#ev-ones-008正式插件状态提交与独立回读2026-11-10)。用户明确授权本次正式插件加载、目标及完整总结；Main 在现有插件自身 Vault 登录下通过 CLI 调用正式 handler，未提取浏览器凭证。

| 证据 | 结果 |
| --- | --- |
| `9c3bf1`：comment-only 的“确认→修复中” | verified，状态/字段/评论均 true，async none |
| `2bc423`：重新 detail/options 后“已完成修复→已修复” | 用户确认的根因、解决版本和完整总结单次提交，verified，三项均 true，async none |
| `82a8ba`：最终独立只读核对 | 新详情为已修复、本次两条评论存在，账本 verified；独立 reconcile 三项 true，首屏列表行状态已修复；statusWriteEnabled true、hoursWriteEnabled false |
| Main 视觉验收 | 已实际打开表单/预览/unknown/成功四张代表截图检查通过；Builder 另检查全部截图和键盘旅程 |

以上实写使用源码指纹 `78f4fae93f50f1ea56c73bacb81009ff70af3ba31ab48318602c5cc605818baf`；随后仅文档/注释收口，复用有效行为证据，没有额外 mutation 或重跑既有测试。真实操作只按当前允许工作流执行，没有直接写 status_uuid、没有重放先前已修复样本。

结论：正式 CLI handler → Worker → Adapter/API → 独立回读通过；fixture UI 的表单/预览/防重/刷新与截图通过。**没有宣称真实人工点击 UI 到服务端整链通过**，亦未用 fixture 证明真实异常恢复。异步 `none` 仍不是后置完成；其它项目/schema、真实网络失败/崩溃恢复、跨平台仍未验证。状态写闸只开放 Adapter 明确支持的步骤，工时及其它 Bug 写入继续关闭。


## 2026-11-10 缓存与回执定向验证

环境：安装版 Orca 的 Node 24.22.1 实测可加载 `node:sqlite` 并读取 SQLite 3.53.4；源码测试运行于本机 Node 26.0.0，复用安装版 `orca-test-register.mjs`。不修改真实宿主或 ONES，不运行全量测试。

- `repair-cache.test.ts` + `repair.test.ts`：20/20。覆盖 SQLite 重启/账号隔离、快照/并发 CAS、离线完成与首次回执幂等、旧 run/token/revision、缺验证证据、未知字段、权限/符号链接/容量拒绝、原始修复防重发、缓存首屏零网络、单 scope 合并同步、首次对账后定向刷新、网络失败保留、明确权限拒绝隐藏及转回恢复。
- `bug-detail-service.test.ts` 仅选择 `repair (cache|list) service`：2/2。覆盖本地 scope 零网络、单次类型读取、分页/定向请求、注销/取消失效。
- TypeScript 严格检查通过（既有本机 tsc，`--preserveSymlinks false` 与插件生成类型）；`orca plugin validate <task-worktree>/plugin --json` valid=true，无新增 capability。
- `cache-panel.browser.mjs`：独立无头 Chrome 虚构桥接预览，缓存先于未完成网络显示、30 秒内重入不额外同步、Agent 结果独立标签、失败保留缓存、认证失效清屏、轮询后刷新按钮可用、离页迟到响应不覆盖均通过，pageErrors=[]。这不是正式 Orca Worker/真实 ONES/真实 Agent 的端到端通过。
- 首轮原 prompt 精确前缀测试因新增外部数据边界失败，更新对应合同断言后通过。预览默认 Playwright 浏览器缺失，未下载，显式复用已安装 Google Chrome 的隔离临时 profile 后通过。

视觉：已实际打开检查最终 360×1000 深浅色缓存加载、Agent 完成报告与失败保留缓存截图。标题、状态、长路径、按钮正常换行，无横向溢出、遮挡或截断。加载图中的 1970 日期为刻意过期的虚构缓存时间，不是用户数据。

证据位于本机临时 scratch，可能被清理：
- [缓存先显示](</Users/choshim/Library/Application Support/orca/chat-scratch/d0d93ac6da7f8104049ca55fa4ae7fed/cache-receipts/cache-first-light.png>)
- [完成回执深色窄屏](</Users/choshim/Library/Application Support/orca/chat-scratch/d0d93ac6da7f8104049ca55fa4ae7fed/cache-receipts/receipt-dark-narrow.png>)
- [同步失败保留缓存](</Users/choshim/Library/Application Support/orca/chat-scratch/d0d93ac6da7f8104049ca55fa4ae7fed/cache-receipts/sync-failed-cache.png>)
- 同目录 `browser-evidence.json` 保存旅程判据。

复现：`ONES_TOOLING=<已安装 Orca tooling checkout> ONES_BROWSER=<现有 Chrome executable> ONES_EVIDENCE=<证据目录> node plugin/tests/cache-panel.browser.mjs`。真实部署、真实接口更新/时延、Agent 沙箱对 result.json 的实际写权限，以及证据内容的独立核验尚未覆盖。


## 2026-11-10 修复流程调整：定向证据

源码范围为 `agent/repair-flow` 隔离 worktree，基线 `09ce73a5b280970cb444a6123671f74fac0bcd83`。本节不复用旧真实状态写入来冒充新多步业务操作已上线。

- `repair-actions.test.ts`：11/11。使用真实 Workbench、OnesTransitions、StatusWorkflow、StatusJournal、RepairWorkflow 与虚构 fetch/CLI，覆盖完整路径先预检、单次确认两步后 launch、确认入口与目标绑定、后续必填/CLI/未知 schema 零写、第一/第二步 unknown、重启 reconcile 后剩余路径不重发、配置漂移保留部分成功、最后回读后外部状态变化零启动、launch unknown 保留修复中、注销、四项自动评论、未验收门槛及报告/源码版本变化废止确认。
- `repair-cache.test.ts`：7/7。保留账户、CAS、文件权限/大小、旧 run 与重启保护；新增结构化代码 fixed + 硬件 not_run、旧报告只读不猜测、序号递增 not_run→passed、逆序/同序号篡改拒绝、相同报告幂等及审计。
- 受影响既有 `status-update.test.ts` 10/10、`repair.test.ts` 15/15；仍覆盖防重、账本失败、回读字段/本人评论、跨 Worker 锁、崩溃只读核对及描述不变。不运行全量测试。
- 严格 TypeScript、插件静态校验与 diff 检查作为收尾检查；真实账号不写入、不安装或重载正式插件。
- `repair-flow.browser.mjs`：完整 HTML 组件 + 虚构 Worker 的隔离 Chrome 旅程，单次开始确认、详情折叠技术信息、列表直达状态表单、四项填充、编辑文字不能解锁验收、未知结果核对不重发、键盘焦点回退通过，pageErrors=[]。`cache-panel.browser.mjs` 的缓存先显、快速重入、失败保留、认证隐藏与迟到响应保护通过。

预览最初在 about:blank 环境缺少 secure-context `crypto.randomUUID` 而超时；改为只绑定 127.0.0.1 的临时服务器，不修改产品代码或注入 crypto polyfill，旅程通过。首轮业务测试仅因“核对/核实”的断言文案不一致失败，修正断言后通过。

### 视觉检查

已实际打开最终代表性截图，检查 360px/460px 深浅色列表、详情技术折叠/展开、开始修复整路径确认、未完成验收禁用和已修复预览：文字、长路径、按钮正常换行，无遮挡、截断或横向溢出。以下为 Chrome 虚构数据渲染预览，不是正式 Orca/ONES 或真实硬件验证；scratch 可能被清理。

- [精简实施列表](</Users/choshim/Library/Application Support/orca/chat-scratch/d0d93ac6da7f8104049ca55fa4ae7fed/repair-flow/implementation-clean-list.png>)
- [详情技术信息](</Users/choshim/Library/Application Support/orca/chat-scratch/d0d93ac6da7f8104049ca55fa4ae7fed/repair-flow/repair-detail-technical.png>)
- [一次开始修复确认](</Users/choshim/Library/Application Support/orca/chat-scratch/d0d93ac6da7f8104049ca55fa4ae7fed/repair-flow/repair-business-confirm.png>)
- [未完成验收保护](</Users/choshim/Library/Application Support/orca/chat-scratch/d0d93ac6da7f8104049ca55fa4ae7fed/repair-flow/completion-validation-blocked.png>)
- [一次完成状态预览](</Users/choshim/Library/Application Support/orca/chat-scratch/d0d93ac6da7f8104049ca55fa4ae7fed/repair-flow/completion-business-preview.png>)

同目录 `repair-flow-evidence.json` 为旅程证据；缓存回归证据在相邻 `repair-flow-cache-regression/browser-evidence.json`。重现使用已有工具：`ONES_TOOLING=<Orca tooling checkout> ONES_BROWSER=<Chrome executable> ONES_EVIDENCE=<证据目录> node --import <安装版 orca-test-register.mjs> plugin/tests/repair-flow.browser.mjs`。

未覆盖：真实项目完整路径与字段权限现场复验、真实 Agent 按新结构化协议/序号写入、真实远端部分成功恢复、证据内容独立核验。API 没有已证明的跨客户端 CAS；写前/逐步回读不构成远端原子事务。用户批准实施不包含部署、提交、合并、推送或真实 Bug 状态操作。


## 2026-11-10 开始修复不提交评论：定向证据

范围：`agent/repair-no-comment`，基线 `9514eaf32ab99c9726a07ab8342e78e8fd5f7503`。无正式插件重载、真实 Bug 写入或历史评论删除。

- 部署前端只读证据：`app.842f08a8.js` 可选 discussion、`733.9178f7c8.js` 条件 UUID 和 new_transit 参数组装；工具回执 `4db3cab9-ab71-4b8c-abd5-7d44e8c48e77`。不是服务端无评论写入证据，细节见接口 §6.3。
- macOS / Node v26.0.0；安装版 `orca-test-register.mjs` loader，`node --import <loader> --test plugin/tests/repair-actions.test.ts plugin/tests/status-update.test.ts`：23/23，通过两步均无 discussion、状态核对不读 messages、状态/字段确认后启动、两步任一评论必填零写、注入评论丢弃、无评论 unknown 重启核对、完成评论及门槛、旧字符串意图回读与既有锁/防重保护。未运行全套。
- 官方本地类型生成后 `tsc -p plugin --preserveSymlinks false --typeRoots <本地 Orca types>,<已有工具 @types>` 通过。首次类型检查发现 nullable 测试断言缺少收窄，修正后通过；不是运行时失败。
- `ONES_JOURNEY=repair` 的 `repair-flow.browser.mjs`：完整 HTML + 虚构 Worker，隔离 Headless Chrome，单次确认、必填、无评论提示、技术折叠及无重复启动通过，pageErrors=[]。仅运行受影响修复旅程，没有重复完成状态/列表旅程。
- 已实际打开检查 [360px 开始修复确认](</Users/choshim/Library/Application Support/orca/chat-scratch/d0d93ac6da7f8104049ca55fa4ae7fed/repair-no-comment/repair-business-confirm.png>)：路径、字段值、无评论说明与按钮完整可见，换行自然，无遮挡或横向溢出。来源为浏览器预览，不是正式插件或真实 ONES 验收。旁侧 `repair-no-comment-evidence.json` 为旅程证据；chat-scratch 临时目录可能清理。

剩余边界：真实实例无评论状态写入未执行；不保证远端原子事务/操作归因。无评论且无字段时，回读仅证明目标状态已达成；后置 async none 仍不代表 done。原有带评论历史账本仍可读，已存在评论不删除。


### 同一任务追加：会话协议精简

- 生产 formatter 保留完整原单及外部数据边界，执行摘要为四行；完整模板移动到本 run `receipt-instructions.md`。每次 launch 前完成 wx 创建、0600 权限检查、文件及目录同步。协议生成只接收插件绑定，不接收 Bug 数据。
- `repair.test.ts` 定向 selector：`repair content: exact|repair workflow: persists|repair workflow: failed media|repair workflow: unknown process|repair receipt instructions:`，6/6 通过。覆盖完整内容、私有文件在 launch 前可读、正文无 token/run/revision/JSON、协议写失败 registered cleanup/零 launch、未知启动保留文件、重启后有效 result.json 受理及远端状态不变。
- `repair-cache.test.ts` 的 `cache: replacement run`：1/1 通过，更新 formatter 调用后验证旧 run 不能覆盖及完整协议仍绑定正确 result 路径。首次类型检查发现该旧测试仍传 ReceiptContract，已同步新 producer 参数，随后类型检查通过。未重跑状态测试/UI，复用前述无评论证据；状态链测试仅同步了提示中协议路径断言。
- 只渲染真实 formatter 生成的虚构消息，`repair-prompt.browser.mjs` / Headless Chrome 460px 通过无横向溢出断言；已实际打开 [精简会话文本](</Users/choshim/Library/Application Support/orca/chat-scratch/d0d93ac6da7f8104049ca55fa4ae7fed/repair-no-comment/repair-prompt-short.png>)，确认正文、四行摘要及长路径完整换行，未显示 JSON/令牌，无截断遮挡。该图是文本渲染预览，不是 Orca 真实聊天，chat-scratch 可能清理。同目录 `repair-prompt-evidence.json` 保留渲染证据。
- 未验证真实 Agent 对新增协议文件的 sandbox 读取权限；不可读/写按协议明确报告阻塞。没有重载正式插件、启动真实 Agent 或写 ONES。数据库 consumer、序号与权限合同未修改。


### 同一任务追加：三项白话评论

- 定向 selector `structured report: fixed|completion business: authoritative|repair receipt instructions: private complete`，分别位于 `repair-cache.test.ts`、`repair-actions.test.ts`、`repair.test.ts`：3/3 通过；类型检查通过。覆盖 formatter 恰好三行且无来源/验证/交付段落、旧长字段完整保留与换行规范、独立未验收 gate、发布精确三项 HTML、私有协议要求一句简短白话及独立技术字段。
- `ONES_JOURNEY=comment` 的现有 Chrome harness 仅运行三项表单旅程：360/460px、长旧文本完整编辑与滚动、编辑评论不能解锁完成，通过且 pageErrors=[]。没有执行状态写入或重跑修复启动旅程。
- 已实际打开 [360px 浅色](</Users/choshim/Library/Application Support/orca/chat-scratch/d0d93ac6da7f8104049ca55fa4ae7fed/repair-no-comment/completion-three-items-360.png>) 与 [460px 深色](</Users/choshim/Library/Application Support/orca/chat-scratch/d0d93ac6da7f8104049ca55fa4ae7fed/repair-no-comment/completion-three-items-460.png>)：三项标签和内容均可见，紧凑输入框、未验收红色提醒、禁用预览按钮完整，无遮挡或横向溢出。证据为完整 HTML + 虚构 Worker 渲染预览，不是正式插件或真实 ONES；chat-scratch 可能清理，同目录 `repair-three-items-evidence.json` 记录旅程。
- 不保证已有长报告自动变成白话：未引入模型摘要或机械裁剪，仅要求后续 Agent 简述；历史原文保留。未修改内部回执验证器的字段/序号/权限规则、未重载正式插件、未操作真实 Bug。


### 同一任务追加：Bug 正文空白归一化

- `bug-content.test.ts` 7/7 通过：嵌套 div/p/br、空段与 NBSP 行、CRLF/plain、单换行/缩进、标题/列表、pre/code 空白与边界空格、显式 plain 代码围栏、图片视频顺序、受控资源及隐藏可执行内容、超限拒绝。
- `bug-details.test.ts` 的 `content spacing: shared comment reader` 1/1 通过：共享评论解析压缩空段且作者/分页不变。
- `repair.test.ts` 的 `content spacing: repair prompt` 1/1 通过：Agent 正文直接复用同一解析结果，保留媒体引用顺序，不引入额外格式化规则。类型检查通过；只运行上述 9 个受影响测试。
- `ONES_JOURNEY=content` 独立虚构详情旅程通过，pageErrors=[]；fixture 使用生产解析器处理大量嵌套空段和媒体标识。已实际打开 [360px 浅色正文](</Users/choshim/Library/Application Support/orca/chat-scratch/d0d93ac6da7f8104049ca55fa4ae7fed/repair-no-comment/content-spacing-360.png>) 与 [460px 深色正文](</Users/choshim/Library/Application Support/orca/chat-scratch/d0d93ac6da7f8104049ca55fa4ae7fed/repair-no-comment/content-spacing-460.png>)：步骤、实际/期望结果均保留适度段落间隔，图片完整加载，图片说明/视频占位/后文顺序正确，无文字或媒体遮挡、截断和横向溢出。
- 截图来自完整 HTML + 虚构 Worker 的隔离 Chrome 预览，不是正式插件或真实 Bug。视频只检查占位与顺序，没有重跑播放/硬件验证；未调整播放器。chat-scratch 可能清理，同目录 `content-spacing-evidence.json` 为旅程证据。
- 行为边界：HTML pre/code 保留解析后的文本空白（HTML 本身的换行解析遵循 parse5）；纯文本有明确代码围栏时保守全文保留，未标注代码的 plain 按普通文本处理。非空行开头缩进不删除；不改写事实，不删除有文字的小标题。无部署、Git 交付或真实 ONES 写入。


### 同一任务追加：图片限高，移除放大交互后的最终证据

- 按用户最终要求移除本任务新增的 dialog、图片触发按钮、aria-haspopup、键盘入口、关闭/焦点逻辑及专属 CSS；保留 240px 图片区域、contain、小图不放大、既有资源释放与视频行为。owned 测试改为 `image-sizing.browser.mjs`。
- 类型检查、`git diff --check` 通过；`html-media.test.ts` 3/3 通过，覆盖 Blob 撤销、恶意 MIME/尺寸拒绝、取消迟到结果。
- 尺寸浏览器旅程通过：600×1800 纵图显示 80×240，1800×600 横图显示 420×140，80×40 小图保持 80×40；三者区域均高 240px、顺序保持。图片无 button/tabindex/aria-haspopup，点击无额外请求或弹层；dispose 后图片移除、旧 Blob 不可读；加载中/安全拒绝图片不显示，视频 controls/autoplay/未限高保持不变，pageErrors=[]。
- 已实际打开 [460px 浅色尺寸](</Users/choshim/Library/Application Support/orca/chat-scratch/d0d93ac6da7f8104049ca55fa4ae7fed/repair-no-comment/image-sizing-460.png>) 和 [360px 深色尺寸](</Users/choshim/Library/Application Support/orca/chat-scratch/d0d93ac6da7f8104049ca55fa4ae7fed/repair-no-comment/image-sizing-360.png>)：无放大入口，纵横图完整不裁剪，小图未放大，无横向溢出、遮挡或截断。旁侧 `image-sizing-evidence.json` 为本次证据；此前放大交互截图不再代表最终实现。
- 来源为隔离 Chrome + 生产组件/虚构数据，不是正式插件现场验收；chat-scratch 可能清理。未加载外部图片、操作真实数据、增加权限或重载插件；视频只验证本次不受影响的配置，未重跑播放或硬件验收。

## 修复说明分段格式（repair-summary-layout）

基线 `main@787186cbe40ed772df8adb5abedfec73b471bc56`；仅将 repairComment 的三项标题独占一行、内容从次行开始、项间空一行。不改文字内容、既有换行规范化、长度保留或验证/交付边界，不改变 textarea 尺寸。

- 类型检查通过；定向 selector `structured report: fixed|completion business: authoritative`（repair-cache/repair-actions）2/2 通过，覆盖分段文本及 `<br>` 精确输出、旧长内容保留与未验收门槛。
- `ONES_JOURNEY=summary` 仅运行虚构状态确认预览，不提交：三项分段、360/460px 无横向溢出，pageErrors=[]。
- 已实际打开 [360px 浅色](</Users/choshim/Library/Application Support/orca/chat-scratch/d0d93ac6da7f8104049ca55fa4ae7fed/repair-summary-layout/summary-layout-360.png>)、[460px 深色](</Users/choshim/Library/Application Support/orca/chat-scratch/d0d93ac6da7f8104049ca55fa4ae7fed/repair-summary-layout/summary-layout-460.png>)：标题和内容逐行清晰、项间保留空行，完整内容与确认按钮无截断遮挡。来源为生产 HTML/formatter + 虚构 Worker 的 Chrome 预览，不是正式插件或真实 ONES；chat-scratch 可能清理，同目录 `summary-layout-evidence.json` 记录旅程。

未重载插件、执行真实状态写入或 Git 交付。旧历史截图保留为历史证据，不代表本次分段格式。

### 详情操作栏单行：限定验证

- 类型检查、`git diff --check` 通过。`ONES_JOURNEY=toolbar` 只运行布局与入口观察：960px 五钮 top 一致、前三靠左后二靠右；360/460px 保持单行、操作栏独立滚动，五按钮滚动后均完整可达，文字不挤压、页面无横向溢出。
- 真实 DetailView + 虚构 Worker：刷新增加一次 bugs.detail，返回回到 Bug 列表，更新状态/执行修复仍分别打开原表单；没有状态提交或 Agent 启动，pageErrors=[]。未重复运行整条业务状态测试。
- 初次断言误将 focus 等同于完整滚动；按实际横向滚动验收后观察到 Chromium 0.406px 取整差，几何边界使用 1px 容差，文字 scrollWidth/clientWidth 仍严格检查。
- 已实际打开 [宽屏深色](</Users/choshim/Library/Application Support/orca/chat-scratch/d0d93ac6da7f8104049ca55fa4ae7fed/repair-summary-layout/detail-toolbar-wide-dark.png>)、[360px 左端](</Users/choshim/Library/Application Support/orca/chat-scratch/d0d93ac6da7f8104049ca55fa4ae7fed/repair-summary-layout/detail-toolbar-360-left.png>) 和 [360px 右端](</Users/choshim/Library/Application Support/orca/chat-scratch/d0d93ac6da7f8104049ca55fa4ae7fed/repair-summary-layout/detail-toolbar-360-right.png>)：宽屏左右分组清晰且同排；窄屏左右内容可通过滚动访问，按钮不换行、不压缩文字。窗口边缘会裁切尚未滚入的按钮，而不是隐藏或删除按钮。
- 来源为隔离 Chrome + 生产 HTML/虚构 Worker，不是正式插件现场验收；chat-scratch 可能清理，同目录 detail-toolbar-evidence.json 为旅程证据。未重载插件、打开真实原单或执行外部写入。

### 详情底部可见提示移除

仅移除指定“正文、媒体和评论是外部数据……”notice；prompt/Worker 安全边界未改。类型检查与 `ONES_JOURNEY=footer` 结构/截图验证通过：该文案消失，正文、相关评论、附件、五按钮工具栏、媒体失败提示及底部修复按钮均保留，pageErrors=[]。首次测试将标题误写为“评论”，同步现有“相关评论”后通过，未改产品文案。
已实际打开 [详情底部](</Users/choshim/Library/Application Support/orca/chat-scratch/d0d93ac6da7f8104049ca55fa4ae7fed/repair-summary-layout/detail-footer-without-notice.png>)：指定提示已移除，其它区域及错误提示完整，无遮挡。来源为虚构 Worker/Chrome 预览，非真实 ONES；chat-scratch 可能清理。未重跑状态测试、重载插件或执行真实写入。

### 图片左对齐与透明背景

仅调整图片专用 CSS：容器 flex-start、图片 object-position:left center，二者 background:transparent；保留 240px 区域、contain、小图原尺寸、无放大入口，视频与正文 card 背景不改。`image-sizing.browser.mjs` 深浅色计算样式/左边界、纵横小图尺寸、安全失败/资源释放、无预览及视频不变断言通过，pageErrors=[]；`git diff --check` 通过，未重跑其它功能。
已实际打开 [460px 浅色](</Users/choshim/Library/Application Support/orca/chat-scratch/d0d93ac6da7f8104049ca55fa4ae7fed/repair-summary-layout/image-left-transparent-460.png>)、[360px 深色](</Users/choshim/Library/Application Support/orca/chat-scratch/d0d93ac6da7f8104049ca55fa4ae7fed/repair-summary-layout/image-left-transparent-360.png>)：图片靠左、容器灰底消失、图像完整无裁剪遮挡；原图片像素未修改。来源为 Chrome/生产组件/虚构数据，非正式插件现场验收，chat-scratch 可能清理。证据为同目录 image-left-transparent-evidence.json。

### 单元测试计数与已修复门槛

`agent/unit-test-gate`，基线 `main@3d3f34b0a4bfdb29932c27b4558962a1e6f0b406`。v3 回执用明确 unitTests 分类计数控制完成门槛；旧 v2 只读保留且计数未知，不转换历史状态。硬件/截图/人工剩余项保留在技术记录，不阻断单元测试全部通过后的已修复操作。

- 类型检查、`git diff --check` 通过。定向 selectors（repair-cache/repair-actions/repair 三文件）共 11 个通过：`unit-test contract:|structured report: fixed|report sequence:|completion business:|repair receipt instructions: private complete|cache: offline completion|cache: wrong run`。覆盖真实业务类 + 虚构 API 的 3/3 且硬件未验收提交成功、2/3/0/0/失败/skip/notRun 零写、评论不可解锁、计数/状态不一致拒绝、旧 v2 文件重启不丢失及显式更高序号 v3 更新、逆序/篡改拒绝、报告/源码变更使旧预览失效；三项分段评论与私有协议 0600/启动/离线回执链路保留。
- `ONES_JOURNEY=unit-tests`：360/460px 表单显示 2/3 阻止预览、刷新后 3/3 可预览且通过计数仍可见；编辑长评论不能解锁。`ONES_JOURNEY=unit-list`：实施列表与修复详情同样显示短计数，无结果显示未知；硬件原因留在折叠技术信息。两旅程 pageErrors=[]，只运行这些 selector，没有全量测试。
- 首次 producer 测试残留“remaining 为空”旧期望，按新合同修正后通过；UI 旅程分别修正刷新数据、tab 角色与重复按钮定位，未改业务行为或放宽断言。
- 已实际打开 [360px 2/3](</Users/choshim/Library/Application Support/orca/chat-scratch/d0d93ac6da7f8104049ca55fa4ae7fed/unit-test-gate/completion-three-items-360.png>)、[460px 3/3](</Users/choshim/Library/Application Support/orca/chat-scratch/d0d93ac6da7f8104049ca55fa4ae7fed/unit-test-gate/completion-unit-passed-460.png>)、[460px 实施列表](</Users/choshim/Library/Application Support/orca/chat-scratch/d0d93ac6da7f8104049ca55fa4ae7fed/unit-test-gate/unit-list-460.png>)、[360px 修复详情](</Users/choshim/Library/Application Support/orca/chat-scratch/d0d93ac6da7f8104049ca55fa4ae7fed/unit-test-gate/repair-detail-unit-count-360.png>)：短计数、按钮与三项说明布局正常，无横向溢出或遮挡；编辑区保持既有滚动，不截断存储内容。来源为 Chrome + 完整生产 HTML/虚构 Worker，非正式插件或真实 ONES 验收；chat-scratch 可能清理。
- 单元测试结果仍为 Agent 结构化报告，不是插件独立重跑/核验测试真实性；旧会话 v2 私有协议不自动改写，继续时需明确提供 v3 合同和原绑定后以更高序号回报，不能只改版本号伪造计数。未触及真实运行文件、真实 Bug、正式插件加载或 Git 交付。

## 2026-11-11 ONES 续期与解锁状态同步

- 隔离范围：基线 main@562d65b5c05ee95bc8f0bb4d22beca45c972c4af；任务分支 agent/ones-refresh-token；Git root 为 /Users/choshim/.agent-worktrees/aputure-ones/agent/ones-refresh-token。Main 为唯一 writer；ownership 为认证 adapter/service、HTML 认证同步、对应测试和认证说明（含 plugin/README.md）。原主工作区未修改，未提交、合并或部署。
- 协议事实：只读获取该实例公开 Identity 脚本 main-3ce87560.js，确认 /identity/oauth/token、refresh_token 表单、ones.v1、轮换及 invalid_grant 分支。未读取真实账号凭证、未执行真实 refresh grant。
- 行为：接近有效期 60 秒内按需续期，业务请求前及前台恢复均检查；单 Worker 并发合并、令牌轮换只存 secrets，校验 keyring。退出/换号使用代次及 session 引用阻止迟到续期污染新账号；同身份轮换不改变业务身份代次。无业务操作自动重放。网络/服务/未知响应错误保留凭据，明确失效只清除对应站点。
- UI：focus/visibilitychange 触发权威状态同步；任意面板的 auth 错误统一通知状态同步，失效时清理业务展示；dispose 移除监听并拒绝迟到状态。不是依靠锁屏计时器保持登录。
- 定向单元验证：auth-refresh.test.ts 10/10、auth-lifecycle.test.ts 9/9、protections.test.ts 中 TC-PLUGIN-001 与 TC-PLUGIN-004 系列 8/8，以及 service authority survives stale preview 1/1；共 28 个不同用例通过。初次新增 fixture 缺少 issue_types 回包导致 2 项失败，补齐虚构配置后通过。最终 OAuth HTTP-400 解析收窄后，重验续期 10 项与登录/脱敏 2 项通过，其余未受影响证据复用；未运行全量测试。
- 交互验证：auth-refresh.browser.mjs 使用生产 HTML + Workbench、虚构 HTTP/Vault、Headless Chrome。跨过有效期后 focus 自动续期且下一次缺陷读取成功；visibility 下网络失败保留 Vault，后续恢复成功；401 后 ONES 未登录、私有列表清除、Coho 已认证；dispose 无后续请求。pageErrors=[]。
- 视觉验证：实际打开 auth-resumed-dark.png（900px）与 auth-expired-light-360.png（360px），认证徽标/列表/禁用按钮一致，正文无新增截断或遮挡、无页面横向溢出；窄屏顶部导航沿用横向滚动。来源为渲染预览，不代表真实 Orca 或物理锁屏实测。截图后仅收窄 OAuth 400 解析和恢复本地草稿原行为，均不改变被测页面、成功续期及401路径，因此复用截图。
- 证据目录：/Users/choshim/Library/Application Support/orca/chat-scratch/6bd22500e7f0300e1f445df210027159/auth-refresh/，含 auth-browser-evidence.json 及上述 PNG；临时缓存可能被清理。
- 静态验证：使用已有 Orca 宿主类型和本机 TypeScript，对任务 Worktree 的 src/tests 执行 noEmit 检查通过；git diff --check 通过。浏览器 bundle 曾提示任务 Worktree 尚未生成 .orca/types，未阻止编译/运行；独立 noEmit 使用原工作区已有类型解析通过，未安装依赖。
- 未覆盖：真实账号 refresh grant、宿主凭据库轮换写入、真实锁屏/解锁及部署后的端到端。旧版本没有保存 refresh token，部署后需登录 ONES 一次；不从浏览器或其它 profile 导入凭据。Coho 不新增未经核实的刷新协议。

## 2026-11-11 双平台显式保存凭据与过期自动登录

本节替代上一节“密码不保存/Coho 不自动登录”的旧边界；不改变 refresh token 与密码重登的区别。继续复用 agent/ones-refresh-token 独占 Worktree，基线 main@562d65b5c05ee95bc8f0bb4d22beca45c972c4af。新增 ownership 为 Coho adapter、认证 DTO/Worker handler、保存登录 UI、定向 fixtures/tests、plugin/README.md 与两站认证说明；Main 单 writer，主工作区仍未修改。

- 两站独立、默认关闭；仅成功登录且 remember=true 才保存。credentials.ones/coho 仅在宿主 secrets；Status 只含保存账号及暂停/退避状态，不含密码/令牌。ONES 保存固定实例的 HTTP 风险同意，自动登录核对原 userId，Coho 核对 ATS/globalId。
- ONES refresh 优先；明确 grant 失效或无 refresh 才回退保存密码。Coho 使用 expTime 秒有效期、识别 HTTP/业务401，以保存密码重新登录，不伪造 refresh endpoint。
- 每站共享自动登录 flight；发送前持久化暂停 claim，Worker 中断后不循环发密码。验证码/密码错误/身份变化/未知失败暂停；网络/限流至少退避60秒。系统保护不可用时零密码发送与零密码记录写入。
- 手动登录阻止旧凭据自动登录竞争；取消保存/退出中止旧 flight，旧回包与写入不恢复凭据。双 key 写入先完整持久化再发布内存，失败/取消在串行队列中回滚，底层不可写/不可删时明确报错，不宣称删除成功。自动重登改变身份代次，使旧确认及展示失效；无业务自动重放。
- 定向单测：auth-lifecycle 9、auth-refresh 10、coho-auth 5、remember-login 15、protections 中认证与写保护9，共48个不同用例通过。补充系统保护零写、验证码暂停、手动登录竞争、配对写失败回滚、取消/退出时持久化与单平台恢复边界。最后局部变更仅复验相关用例，未执行全套测试。
- UI：remember-login.browser.mjs（生产 HTML + Workbench，虚构 HTTP/Vault，Headless Chrome）通过双勾选默认关闭、成功保存/不回填密码、过期focus双站恢复、ONES refresh失败回退、业务401后恢复并清除矛盾错误、单平台恢复、取消勾选删除、失败暂停、未登录时退出删除、360px无横向溢出。pageErrors=[]。auth-refresh.browser.mjs 未保存凭据旅程回归通过，401 fixture 同时令 refresh grant 失效，避免错误模拟“有效 refresh 不可恢复”。
- 已实际打开检查 saved-login-both-dark.png（900px）、saved-login-paused-light-360.png（360px）：勾选框、说明、暂停提示、密码空输入、按钮均完整，无新增遮挡；窄屏顶部导航仍为既有横向滚动。证据目录 /Users/choshim/Library/Application Support/orca/chat-scratch/6bd22500e7f0300e1f445df210027159/remember-login/，含 remember-browser-evidence.json 与 saved-login-recovered.png。均为虚构账号渲染预览，缓存可能清理。
- noEmit 类型检查及 git diff --check 通过，plugin validate valid=true。类型检查复用已有宿主类型；浏览器打包的未生成本地 .orca/types 提示不作为类型验证通过证据。
- 真实验证（用户批准后）：任务 Worktree 开发版获准加载；Orca 重启后确认仍为 running / needsReconsent=false，未重复加载。通过原生登录表单完成 ONES 与 Coho 真实认证，两站均显示已认证与凭据已保存、密码输入框为空。随后重启 Worker，status 脱敏结果均为 connected=true / saved=true / paused=false，证实宿主凭据保存与恢复。未直接读取 secrets，密码未放入命令行/源码/测试；未执行工时或缺陷写入。
- 现场追加修复：无变化的 focus 状态同步原先也重建表单，导致单击标签/保存选项可能丢失。新增回归先复现失败，再改为仅展示状态变化或认证错误恢复时重绘；无变化时保留控件与键盘焦点。保存登录浏览器旅程共11项通过、pageErrors=[]；类型检查与 diff 检查通过。真实 Orca 单击切页正常，确认 Coho 已勾选后完成保存。
- 真实视觉：实际打开检查 [登录后效果](</Users/choshim/Library/Application Support/orca/chat-scratch/6bd22500e7f0300e1f445df210027159/remember-login/live-auth-saved.png>)（Orca 开发版，781×1350，深色）。两站徽标、保存勾选与空密码框一致，说明和按钮无遮挡/截断；截图命令 errors=[]。该截图只证明所示状态，不代证过期恢复；chat-scratch 可能清理。
- 仍未覆盖：真实账号自然过期后的 refresh grant/密码自动重登、物理锁屏解锁。自动过期与失效恢复路径已由虚构 HTTP/Vault 定向测试覆盖；不改真实令牌有效期或注入测试后门来冒充线上验收。
- 交付：任务开发版保持获准加载，未提交、合并或发布正式版本；保留 Worktree。最终 Source Identity 由 native session-source-identity 写入同证据目录 source-identity.json，不以测试 fixture 成功代称真实账号恢复成功。

### 2026-11-11：历史工时扫描与辅助任务草稿

- 隔离基线：main / 927d2bcc3e1ae5c731a0708050bd2565339dcd7c；任务分支 agent/attendance-hours，Worktree 为 /Users/choshim/.agent-worktrees/ones/agent/attendance-hours。原主工作区未修改，未提交或集成。
- 定向结果：新增 missing-hours.test.ts 6/6；protections.test.ts 与 auth-lifecycle.test.ts 共 21/21。覆盖月份月底/闰日/上海时区、五档范围、分页及重复 key、缺报/部分/异常分离、七日分批及失效游标、网络失败/取消、选日重读、重复草稿及额度保护。使用安装版 Orca 官方测试 loader，无真实服务请求。
- tsc -p plugin、git diff --check、orca plugin validate 通过；未执行全量测试。Node 26 不再接受 experimental-transform-types，初次测试命令未运行用例，随后改用项目规定的宿主 loader 完成验证。
- 视觉与交互：实际 HoursView 编译输出配合虚构宿主请求在 Orca 浏览器渲染，非正式插件安装验收。默认一月、五档选项、一年请求参数、扫描分类、选日/读任务/确认打卡、两小时草稿、重复任务拦截、预览和写入禁用均经交互断言。460 × 950 单屏截图已打开检查，列表和预览文字可读，无遮挡或横向溢出；长截图存在拼接重复，已弃用。未新增样式，暗色主题未另行截图验证。
- 截图（本机 chat-scratch，可能被清理）：
  - /Users/choshim/Library/Application Support/orca/chat-scratch/cf69c9bc9c7462f7c5ca9bb99a6e216b/hours-evidence/scan.png
  - /Users/choshim/Library/Application Support/orca/chat-scratch/cf69c9bc9c7462f7c5ca9bb99a6e216b/hours-evidence/draft.png
- 真实全年查询耗时、完整宿主集成及生产工时提交未验证；写入闸保持关闭。自动生成只辅助任务描述和待确认记录，不推断实际投入或自动填满额度。范围工时超过既有 20 页保护上限会明确失败，需改选较短范围。
