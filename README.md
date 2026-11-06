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
