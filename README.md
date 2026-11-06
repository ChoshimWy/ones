# ONES × Orca

用于规划 Orca 的 ONES 插件：读取 Bug、关联 Orca 实施工作区，以及参考考勤记录手动分配任务工时。

## 文档

- [Coho 考勤接入与工时折算](docs/coho-attendance-api.md)：登录、请求签名、考勤查询、使用示例、实测范围和未完成项。

## 范围与状态

目前只交付接入文档，不代表插件已经实现。

- Bug 转实施：保留 ONES 原 Bug，在 Orca 发起关联实施；不在 ONES 新建或转换任务。
- 工时：读取 Coho 原始打卡，按已确认规则生成额度，由用户手动分配到 ONES Bug／任务，确认后写入。
- Agent 完成不等于 Bug 验收完成；不自动修改 Bug 状态。
- ONES 工时写入接口、身份映射与 Orca 插件集成尚未完成验证。

禁止提交账号、密码、密码摘要、Token、Cookie 值、请求签名、HAR 或个人考勤原始响应。

## 目录与同步边界

| 路径 | 分类与处理 |
| --- | --- |
| `README.md`、`docs/`、`.gitignore` | 仓库文档和规则；脱敏后精确提交 |
| `scripts/`、`tests/`、`config/` | 暂时整目录忽略，包括示例配置；保留本机，不纳入同步，后续另行授权后再评估入库 |
| `.env*`、`*.local.json/yaml/yml` | 本机配置，Git 忽略；凭证优先系统安全存储或运行时注入 |
| `state/` | 本地账本、锁和任务状态，整体忽略；其中历史 schema 不在本次单独发布 |
| `pending-bugs*.json/csv`、`ones-request-validation*.json` | 真实 Bug 快照及接口验证响应，保留本机并忽略 |
| `SidusLinkPro-ONES-Bug-Auto-Fix-Proposal.html` | 历史内部方案，未完成公开内容审查，暂不同步 |
| `exports/`、`captures/`、`artifacts/`、`logs/`、HAR、数据库文件 | 原始数据及运行产物，Git 忽略 |
| `.claude/`、`.codex/`、`.agents/`、`.code-review-graph/` 等 | 本机 Agent 配置和索引，Git 忽略 |

本次仅分类和设置忽略规则，不删除、迁移或修改已有业务数据；不将旧脚本当作已验证的新插件实现。已有脚本的行为与新插件需求可能不同，接入前须另行核对。

### 提交前检查

- 不使用 `git add .`、`git add -A` 或 `git add -f`；只暂存经过审查的精确路径。
- 查看 `git status --short` 和 `git diff --cached --name-only`，再核对 staged diff，不输出原始业务数据或凭证到聊天／日志。
- 对预期留本机的文件用 `git check-ignore -v -- <path>` 确认匹配规则；目录位置变更后重新检查。
- `.gitignore` 只影响未跟踪文件，不保护已跟踪内容，也不能阻止强制添加；源码、测试、示例和自由文本仍需敏感信息检查。不要把实际凭证填入可提交的示例文件。
- Git 忽略不限制网盘、备份工具、Agent 上传或人工复制；这些渠道需要各自设置权限和排除规则。
- 若凭证已经提交或外泄，先撤销／轮换，再单独处理历史清理；新增忽略规则不能撤回历史泄露。
