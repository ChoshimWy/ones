---
document_id: TSD-COHO-001
document_type: technical-design
version: "1.1.0"
status: draft
owner: TBD
related_requirements: []
related_documents: []
updated_at: "2026-11-09"
source_identity: "文档基线 56cb351b7042620eef070a7cdc06ed0438f4950c；现场 WTS 4.0 的 user.f017c521.js、app.f94d29ae.js、chunk-74d85dd4.fbde3ba9.js 及已加载模块 9138；服务端构建版本未知"
evidence: ["EV-COHO-001: 本文第 7 节脱敏实测记录"]
---

# Coho 考勤接入与工时折算

## 1. 范围与状态

记录已获用户授权、于 2026-11-06 完成的只读接口验证，以及用户确认的工时折算规则。涉及认证与个人考勤，按 L3 安全边界记录；不是公开 API 稳定性承诺，也不表示完整 Orca 插件已验收；2026-11-09 开发插件的登录及限定考勤读取证据见 [VR-ONES-PLUGIN-001](orca-plugin-verification.md)。

- 站点：`https://w.coho.net.cn`；考勤页面：`/Workbench/WorkbenchCalendar`。
- 业务链：登录 → 确认当前身份 → 解析员工 ID → 查询考勤 → 确认打卡有效性 → 折算额度 → 手动分配 ONES 任务 → 确认写入。
- 已验证登录、当前身份、指定员工与考勤期查询；ATS 本人员工映射及插件只读链路于 2026-11-09 补充验证；其它租户映射与完整写入闭环仍未完成。
- 考勤只读；不补卡、不修改记录、不自动写工时。2026-11-09 追加验证仍为只读，不新增线上工时。
- 接入负责人尚未指定（owner=TBD）；实施前指定负责人，闭合第 8 节缺口。

## 2. 登录与身份

### 2.1 共同约束

| 项目 | 使用方式 |
| --- | --- |
| 租户 | `tenantCode` 为租户配置；本次验证租户为 `ATS`，不是通用默认值 |
| Cookie | `sso_tenant_code=<tenantCode>`；不重复设置同名 Cookie |
| JSON | `Content-Type: application/json;charset=UTF-8`、`Accept: application/json` |
| 语言 | `COHO-language: zh-CN` |
| 认证 | 登录成功后使用 `Authorization: Bearer <token>` |
| 重定向 | 默认拒绝自动重定向，不能将凭证转发到非预期域名 |
| 成功判定 | HTTP 200 且 JSON `code == 200`；不能只看 HTTP 状态 |

独立客户端缺少租户 Cookie 时，实测被重定向到统一认证页面并得到 HTML，不能当作登录成功。模拟浏览器的 `sec-ch-ua` 等头不是本次独立客户端成功验证的必需项。

### 2.2 获取 Token

```text
POST https://w.coho.net.cn/gateway/auth/account/requestToken
```

```json
{
  "sign": "",
  "timeStamp": "",
  "data": {
    "tenantCode": "<tenant-code>",
    "identifier": "<account>",
    "credential": "<encoded-password>"
  }
}
```

- 本次提供的密码与登录报文 `credential` 经本地比较，符合 **SHA-1(password) 的大写十六进制**；随后独立登录成功。
- 前端模块 9138 的通用逻辑会读取租户认证配置，对 `password + secretKey` 使用配置的 SHA-1／SHA-256／MD5，再转大写。不能把本次 SHA-1、空附加串的结果推广到全部租户。
- `data.token` 是后续 Token；2026-11-11 核实官方登录脚本以 `Date.now() + expTime * 1000` 保存，单位为秒。HTTP 200 的 JSON `code=401` 同样表示认证失效。未发现 refresh token 接入合同；经用户显式勾选后，插件可用 secrets 保存的密码重新认证，不把它称为令牌续期。
- `credential` 虽是摘要，仍可能用于直接登录，必须按密码保护。不得输出、硬编码、落库或提交它。

### 2.3 当前用户与员工 ID

```text
GET https://w.coho.net.cn/gateway/auth/user/getCurrentUser
Authorization: Bearer <token>
```

响应含 `tenantCode`、`tenantId`、`globalId`、`identityType`、`busId`、`envId` 等字段，也可能包含敏感认证字段；禁止打印完整响应。

2026-11-06 的样本只依据已登录页面确认员工 ID，未闭合自动映射。2026-11-09 沿同一实例 `app.f94d29ae.js` 模块 `297a → 1dc8.c` 与 `chunk-74d85dd4.fbde3ba9.js` 核实：`getCurrentUser().data → USER_INFO → WorkbenchCalendar.userInformationId = USER_INFO.globalId`；插件以该链路读取本人 2026-11-06 考勤成功。

因此**仅本实例 ATS、身份回读有效时**，可使用该 `globalId` 作为本人考勤键；不将 `busId` 当作员工键，不推广其它租户，不接受 UI 传入其它员工 ID。两站账号映射仍由本人确认。

登录、身份回读、业务接口必须一致携带 `Cookie: sso_tenant_code=ATS`、`COHO-language: zh-CN` 及本节示例的 Origin/Referer。插件漏带租户上下文时身份回读曾返回 301 到 `cloud.coho.net.cn`，已修复；不把跨站重定向当成功，也不向该域转发令牌。

## 3. 考勤读取接口

### 3.1 考勤期与按月查询

```text
POST /gateway/wtspro-attendance/attQishu/getInfoByDateAndUser
业务 data: {"curDate": "YYYY-MM-DD", "empId": "<employee-id>"}

POST /gateway/wtspro-attendance/attSummaryComfirm/attCalendar
业务 data: {"userId": "<employee-id>", "kqqsId": "<period-id>", "kqqs": "<period>"}
```

第一项为页面网络观察及前端调用链确认的考勤期解析入口，2026-11-09 插件已按所选日期独立读取一个考勤期；跨期仍未验证。前端使用返回 `data.kqqs` 初始化查询期，并将同一值传作日历参数 `kqqsId` 与 `kqqs`；插件匹配此 ATS 实例合同，缺少该值则停止，不默认当月。第二项已独立调用成功。

本次 `kqqsId`、`kqqs` 均为 `202611`，返回 30 天日历；这不证明所有租户的考勤期都与自然月相同。此结论只适用于已核实的 ATS 日历调用链；升级/换租户后重新核对，不将两参数全局视为同义字段。当前报文无分页参数；跨期读取、边界和最大查询范围未验证。

以上 POST 业务参数须使用第 4 节的签名外层，不能直接发送裸业务对象。

### 3.2 返回数据

| 路径 | 字段／用途 |
| --- | --- |
| `data.dateList[]` | `date`、`type`、`cqqs`、`qqgs`、`kggs`；日历范围及系统出勤值 |
| `data.dkList[]` | 原始打卡，见下表；本插件工时折算的输入 |
| `data.detailCountList[]` | `date`、`name`、`code`、`value`、`unit` 等每日指标 |
| `data.summaryCountList[]` | 月度指标，不可直接作为每日分配额度 |
| `data.summaryStatus` | 本次值为 `AttUnlock`；状态全集与锁定语义待验证 |
| `data.shiftInfoList`、`workList` | 班次及相关记录；不默认据此追加可分配工时 |

`dkList` 字段与实测边界：

| 字段 | 已观察内容 | 使用限制 |
| --- | --- | --- |
| `date` | 日期字符串 | 归属语义及跨天规则须核对 |
| `time` | 5 字符时分字符串（`HH:mm`） | 不假定包含秒数 |
| `type` | 本次全部为“上下班” | 不能用于区分上班／下班打卡 |
| `realDate` | 10 字符日期字符串 | 不可在未确认跨天语义时忽略 |
| `isNext` | 本次全部为布尔 `false` | 未验证 `true` 的业务含义与配对规则 |
| `outFence` | 2026-11-09 插件样本为布尔值 | 只有明确 `false` 可进入已确认规则计算；`true` 或未知值阻断，不能推断外勤计时政策 |

系统 `dateList[].cqqs` 与已观察非零日期的 `detailCountList[code="cqgs"].value` 一致，页面单位是小时。但用户随后明确改为**按原始打卡折算**，不能将上述出勤值替代第 6 节规则，也不能额外叠加系统加班汇总。

辅助入口 `POST /gateway/wtspro-attendance/attSummaryComfirm/queryAttDataById` 的业务参数为 `{"id":"<employee-id>","date":"YYYY-MM-DD"}`。本次经页面调用成功，主要返回 `id`、`kqqsId`、`kqqs` 等定位信息，不是每日打卡详情本身。

## 4. 业务请求签名

来源：页面请求封装模块 6022 与摘要模块 60f7；独立客户端已按此算法读取考勤成功。

```text
payload = JSON.stringify(业务 data)
t = Math.round(Date.now() / 1000)
key = lowercase_hex(MD5(token + "&" + t))
sign = lowercase_hex(MD5(key + "&" + t + "&" + payload))
```

外层结构：

```json
{
  "encodeData": "<12-character-random-string>",
  "timeStamp": 0,
  "data": {"userId": "<employee-id>", "kqqsId": "<period-id>", "kqqs": "<period>"},
  "key": "<computed-key>",
  "sign": "<computed-sign>"
}
```

- `timeStamp: 0` 仅为结构示意，实际必须使用当前秒级时间戳；`key`、`sign` 和外层必须复用同一个 `t`。
- 数据字段顺序、字符串编码和数字形式会影响签名；Python 使用 `ensure_ascii=False, separators=(",", ":")`，保留字段插入顺序。本次载荷仅为字符串字段；其他数值类型的跨语言序列化未验证。
- 前端 `encodeData` 使用 12 位随机字符串；独立成功调用使用了 12 位十六进制随机串。不要推断服务端允许任意格式或复用旧值。
- 不记录 `token`、完整签名请求或响应；MD5／SHA-1 是兼容现有站点协议，并非新的安全算法建议。

## 5. 最小 Python 调用示例

以下为脱敏使用示例，不是已交付 SDK。依赖 `requests`；仅支持本次确认的租户密码编码方式。不要把密码放进命令行参数或脚本源码。`COHO_EMPLOYEE_ID` 必须已通过本人身份核对，未解析身份时停止。

```python
import getpass
import hashlib
import json
import os
import secrets
import time

import requests

BASE = "https://w.coho.net.cn"
TENANT = os.environ["COHO_TENANT_CODE"]
EMPLOYEE_ID = os.environ["COHO_EMPLOYEE_ID"]
PERIOD_ID = os.environ["COHO_PERIOD_ID"]
PERIOD = os.environ["COHO_PERIOD"]


def md5_hex(text):
    return hashlib.md5(text.encode("utf-8")).hexdigest()


def read_json(response):
    # 不输出 URL、响应正文或原始异常，避免暴露凭证与个人信息。
    if response.status_code != 200:
        raise RuntimeError("请求失败或被重定向，请核对租户与认证")
    if "application/json" not in response.headers.get("Content-Type", "").lower():
        raise RuntimeError("收到非 JSON 响应，不能视为成功")
    try:
        result = response.json()
    except ValueError:
        raise RuntimeError("响应 JSON 无法解析") from None
    if not isinstance(result, dict) or result.get("code") != 200:
        raise RuntimeError("业务请求失败，请核对权限与登录状态")
    return result["data"]


def signed_body(data, token):
    payload = json.dumps(data, ensure_ascii=False, separators=(",", ":"))
    stamp = int(time.time() + 0.5)
    key = md5_hex(f"{token}&{stamp}")
    return {
        "encodeData": secrets.token_hex(6),
        "timeStamp": stamp,
        "data": data,
        "key": key,
        "sign": md5_hex(f"{key}&{stamp}&{payload}"),
    }


with requests.Session() as session:
    session.cookies.set("sso_tenant_code", TENANT, domain="w.coho.net.cn", path="/")
    session.headers.update({
        "Accept": "application/json",
        "Content-Type": "application/json;charset=UTF-8",
        "COHO-language": "zh-CN",
        "Origin": BASE,
        "Referer": f"{BASE}/user/login?tenantCode={TENANT}&sso_tenant_code={TENANT}",
    })
    account = input("考勤账号：").strip()
    password = getpass.getpass("考勤密码：")
    credential = hashlib.sha1(password.encode("utf-8")).hexdigest().upper()
    del password  # 减少引用，不代表 Python 能保证内存清零。
    auth = read_json(session.post(
        BASE + "/gateway/auth/account/requestToken",
        json={"sign": "", "timeStamp": "", "data": {
            "tenantCode": TENANT, "identifier": account, "credential": credential,
        }}, timeout=25, allow_redirects=False,
    ))
    del credential
    token = auth["token"]
    session.headers["Authorization"] = f"Bearer {token}"
    identity = read_json(session.get(
        BASE + "/gateway/auth/user/getCurrentUser",
        timeout=25, allow_redirects=False,
    ))
    if identity.get("tenantCode") != TENANT:
        raise RuntimeError("当前租户不匹配")
    # 租户检查不等于员工归属检查；调用前须已核对 EMPLOYEE_ID 属于本人。
    business_data = {"userId": EMPLOYEE_ID, "kqqsId": PERIOD_ID, "kqqs": PERIOD}
    attendance = read_json(session.post(
        BASE + "/gateway/wtspro-attendance/attSummaryComfirm/attCalendar",
        data=json.dumps(signed_body(business_data, token),
                        ensure_ascii=False, separators=(",", ":")).encode("utf-8"),
        timeout=25, allow_redirects=False,
    ))
    punches = attendance.get("dkList", [])
    print({"calendar_days": len(attendance.get("dateList", [])),
           "punch_count": len(punches)})
    # 在内存中处理 punches，不打印或持久化个人记录、identity、auth、token。
    del token, auth, identity, attendance, punches
```

使用前在本机配置租户、已核对的员工 ID、考勤期 ID 和考勤期；运行时交互输入账号密码。示例不含自动刷新、批量重试或自动工时提交。登录失败停止，不能循环尝试密码；Token 失效时重新走明确的认证流程。请求的传输异常也不得原样写入包含认证参数的日志。

## 6. 已确认的工时规则

用户已确认：正常基础时段 `09:00～18:30` 计 8 小时；09:00 前正常到岗同样适用基础 8 小时（如 08:50～18:31），早到不额外增加工时；`09:15～21:00` 也计 10 小时。18:30 之后的加班从 19:00 开始计算，每满 30 分钟计 0.5 小时，不足半小时舍弃；加班部分最低为 0。21:00 不是最晚允许打卡时间，也不封顶为 10 小时：08:53～21:02 计 10 小时，09:00～21:30 计 10.5 小时。仅适用同日记录，不扩展跨日政策。

对**恰好两条正常同日打卡、09:00 或之前上班且不早于 18:30 下班**的记录自动适用基础 8 小时；保留 09:15～21:00 的已确认例外。不再要求用户选择或勾选确认正常打卡：

```text
可分配分钟 = 480 + floor(max(0, 下班分钟 - 1140) / 30) × 30
1140 = 19:00，即 18:30 后扣除 30 分钟晚餐
```

| 下班时间 | 可分配小时 |
| --- | ---: |
| 18:30～19:29 | 8 |
| 19:30～19:59 | 8.5 |
| 20:00～20:29 | 9 |
| 20:30～20:59 | 9.5 |
| 21:00～21:29 | 10 |
| 21:30～21:59 | 10.5 |
| 22:00～22:29 | 11 |

自动识别仅接受恰好两条日期明确、非跨日且外勤标志为 false 的有效打卡，按时间先后确定上下班；扫描、草稿预览及提交前重读共用同一规则。缺卡、多卡或异常不能通过人工勾选绕过。用户仍需确认任务分配、描述和最终提交。

- 不能把 `09:15～21:00` 的例外扩展为任意迟到都计足基础工时；09:00 后的其他上班时间政策待确认。
- 18:30 前下班、缺卡、一次打卡、多次打卡、跨天、外勤或记录异常均需人工确认；不得自行补卡、推断未记录的加班或扩展跨日政策。
- 不得对多卡日直接取最早与最晚记录来绕过异常；恰好两条正常打卡可以自动按时间排序。
- 系统打卡是权威输入；折算额度不代表真实任务耗时。由用户手动分配到 ONES Bug／任务，不根据 Agent 运行时长自动分摊。
- 提交前展示当天额度、已登记、本次分配与剩余时长；默认不超额。写入超时结果不明时先核对，不盲目重试。提交后回读。考勤修改导致额度变化时须重新核对草稿，不能自动覆盖已登记工时。
- ONES 写入接口、单位、同日全部已登记工时覆盖及防重能力尚未验证；上述为实现约束，不是已完成功能。

## 7. 脱敏实测记录（EV-COHO-001）

时间：2026-11-06（Asia/Shanghai）。环境：macOS、Python 3.14 标准库独立 HTTP 客户端；辅助分析使用 Orca 1.4.250 已登录页面。测试对象为线上站点，不是本仓库代码。原始 HAR 已删除；保留以下会话工具结果摘要，不提交含个人信息的原始输出。

| 场景 | 实际结果 | 证据边界 |
| --- | --- | --- |
| 独立客户端缺租户 Cookie | 被重定向，JSON 解析失败；公开登录页诊断落到统一认证入口 HTML | 已定位原因；未把 HTTP 200 当作认证成功 |
| 带租户 Cookie 登录 | HTTP 200、`code=200`，Token 存在 | 使用新取得 Token，不依赖浏览器已有 Cookie／Token |
| 当前用户查询 | HTTP 200、`code=200` | 未完成员工 ID 自动映射 |
| 查询考勤期 `202611` | HTTP 200、`code=200`，30 天日历、8 条打卡 | 员工 ID 来自此前本人页面；不是通用身份解析验证 |
| 打卡字段 | `date/time/type/realDate/isNext/outFence` | 样本 `type` 均为“上下班”，`isNext` 均为 false |
| 页面日历指标对照 | 已观察非零日期的 `cqqs` 与 `cqgs.value` 一致 | 不能据此替代用户确认的打卡折算规则 |
| 每日定位接口 | 页面调用 HTTP 200、`code=200` | 返回定位信息，非完整每日明细 |

本次写文档复用上述证据，不再登录或查询。第 5 节 `requests` 示例是根据实测标准库调用整理的等价示例，未以该完整脚本重复执行线上请求。测试通过不保证将来站点版本兼容，也不代表 ONES 写入成功。

## 8. 安全、缺口与后续验证

- 凭证、密码摘要、Token、签名、原始 HAR 和个人打卡不得写进 Git、文档、日志、Agent 上下文或公开截图。提交前检查实际 diff；租户代号与接口地址不作为认证凭证。
- 插件凭证存储机制尚未实现；优先系统安全存储，不用普通配置文件或 UI localStorage 保存密码。示例仅进程内使用，不声称内存安全擦除。
- 保持 TLS 验证，不用 `verify=False`；不要将 Coho Token 发给 ONES。禁止通过跨域重定向转发认证。
- 已在聊天中暴露的密码建议更换；本仓库不保存它或其摘要。

| 待完成项 | 恢复条件／最窄验证 |
| --- | --- |
| 员工 ID 自动解析 | 从合法身份接口闭合本人映射，验证账号／租户不匹配会停止 |
| 租户密码配置与 Token 生命周期 | 核对配置解析、过期、重新认证；不得静默降级算法或无限重试 |
| 打卡配对与异常 | 用获准脱敏样本核对缺卡、多卡、跨天、外勤；不只验证局部算术 |
| 考勤期边界 | 核对非自然月、跨期、无记录与当天未完成；不能按空响应推断 0 工时 |
| 工时算术与规则边界 | 验证 19:29/19:30、19:59/20:00、20:29/20:30、20:59/21:00；未知场景转人工 |
| ONES 登记与回读 | 在明确授权目标下验证单位、重复点击、超时结果不明、余额变化、提交后回读 |
| Orca 集成 | 核对受支持插件 API、后台请求、安全存储和 UI 确认流程 |

文档自检：区分已验证接口、用户决策和待验证项；未将“出勤工时”误作最终额度，未将摘要当作非敏感信息，未把完整示例或插件标为已运行。N/A：本次不实现生产代码、不改变业务状态、不包含 UI 验证。


### 2026-11-11 会话恢复补充

只读核实来源：`https://w.coho.net.cn/js/app.f94d29ae.js` 的认证接口模块、token 保存与业务401分支，以及 `https://w.coho.net.cn/js/user.f017c521.js` 的密码登录成功分支。公开资源需 ATS 租户上下文；未用账号 token 读取。已检查的正式登录路径仅使用 token/expTime，认证失效回到登录页，没有发现可复用的 refresh token 或续期调用；这不构成整个后端绝无其它私有接口的证明。

实现按 expTime 秒数校验有限、安全的正有效期；缺失保留 null，非法值拒绝保存，旧记录不反推有效期。Coho HTTP/JSON401 触发对应会话失效；普通业务错误、403、网络/503 不清除身份。用户勾选保存后可重新执行原已核实密码登录协议，并回读 ATS/globalId 核对原身份；不保存密码摘要代替密码，也不通过猜测端点实现续期。详细保存/暂停/撤销合同见 plugin/README.md。

### 2026-11-11 月度读取的异常隔离边界

- `dkList.date` 为合法日期时，打卡可归属到明确日期。该日 `realDate`、`time` 或 `isNext` 缺失/格式错误返回 `attendance`，提示只含请求日期和固定字段名，不包含原始值；扫描保存该日 `review`，额度与缺口为未知，其他正常日期继续。单日读取与批量预览仍拒绝异常记录，不回填默认时间、不截断时间。
- `dateList` 结构有效但未覆盖请求日期（包括空数组）为该日覆盖未知，也保存 `review`；只有明确覆盖且无打卡才是 `not_required`。有效归属到其他日期的打卡不参与当前日计算，不因未属于当前覆盖列表擅自判整期错误。缺省 `outFence` 仍为未知，不能给预算。
- 整体 `dateList`/`dkList` 类型错误、行非对象或日期无法解析，仍以 `schema` 中断整月且不覆盖完整缓存；`kqqs` 缺失以“Coho 考勤期间查询 + 日期 + kqqs”定位阶段。认证、身份、网络、HTTP、工时完整性错误不转换为日级考勤异常。
- 此为解析与隔离合同修复。现场失败日的具体异常字段尚未读取确认；合成测试中的 `realDate` 示例不是该日真实字段诊断。无需删除本地数据库，修复后强制刷新对应月份即可重新获取摘要。
