# Codex 采集与聚合：范围与实施决策

更新：2026-10-18（Asia/Shanghai）。首期范围已确定，代码在 `codex/codex-usage-backend` 分支；本文件取代早期分析建议。API 契约见 [CODEX-API.md](./CODEX-API.md)，运维说明见 [CODEX-DEPLOYMENT.md](./CODEX-DEPLOYMENT.md)。

## 已确定的范围

- 本地 Mac 与内网 home-center 都采集当前登录账户的额度及各自的本地 Codex 用量。
- 首期只允许指定的一个账户；邮箱在运行配置中指定，稳定账户 ID 首次绑定后不可静默更换。
- 历史从上海时间 2026-10-01 00:00 开始，即 UTC `2026-09-30T16:00:00.000Z`，之后持续增量采集。
- 提供账户、额度、token、金额估值及质量信息给后续 WebUI；本期不改展示层。
- 金额为美元、按当前公开标准 API 价格计算的等价估值。它不代表订阅实付金额、历史账单、额外 credit 扣费或 Fast 模式收费。

## 实现选择

沿用现有 `ua-core` / `ua-probe` / `ua-server` 包结构，在各包内增加 Codex 模块。新增独立 SQLite 状态库、独立 PostgreSQL 表及 `/v1/codex/*` 接口。复用现有机器鉴权和服务器。原 Claude 的归属、队列、预测与默认 profile 逻辑不接入 Codex 账本，避免把不同产品窗口或费用混算。

两台采集器均通过各自的 `codex app-server` 只读读取账户和完整额度快照，不自行管理 OAuth 刷新，也不上报凭证。按账户和采集时间选择最新完整快照；窗口被撤销后不会从旧快照复活，双节点的百分比不会相加。

本地扫描 `sessions` 和 `archived_sessions`，仅提取计量元数据。每个文件的游标、解析状态和不可变事件在同一个 SQLite 事务中提交；网络失败保留队列，服务端确认后才 ACK。拷贝日志、归档搬迁和多节点重放依靠全局事件 ID 去重。

官方 `account/usage/read` 的账户累计摘要单独存储，只用于对照，不与本地事件相加。它的可用日期、字段与本地日志覆盖不同；额度过去的变化不能靠今日快照反推。

## 已处理的难点

| 难点 | 当前处理 | 保留的边界 |
|---|---|---|
| 同一个 token 快照反复出现 | 先比较累计主计数，稳定事件 ID 去重 | 有冲突则保存证据，不悄悄覆盖首份事件 |
| 某节点缺少中间累计快照 | 累计差分与 last 不一致时仅记录可辨认 last，并标记缺口 | 不把未经证明的累计区间重复分摊到其他请求 |
| fork / 子代理带父会话历史 | 保持首个会话身份，识别继承边界，跳过历史前缀 | 边界缺失或推断时保守标记覆盖不完整 |
| 缓存、推理重复计数 | cached/cache-write 属于 input，reasoning 属于 output | 缓存细分缺失时金额未知，不按零价掩盖 |
| 跨节点相同事件不同内容 | 不可变首份记录 + 持久冲突记录 | machine 分组是 first observer，不能证明执行节点 |
| 账号切换与历史归属 | 每轮校验邮箱和稳定 ID；失败不扫描新记录 | 旧日志归属是用户配置的历史绑定，provider 名不证明过去的账单路由 |
| 金额与日志覆盖不全 | 独立返回 pricing_complete、usage_complete、cost_complete | 当前费率估值不能恢复实际订阅消费；未知模型/价格保持 null |
| 登录失效、离线、异常快照 | 独立节点健康状态、快照时间及本地持久队列 | 采集成功不等于覆盖全部 ChatGPT/云端活动 |

## 后续才需要决定的扩展

当前范围已足够实施，无需再确认。以下不阻塞首期：新增账户时的历史分界、是否纳入 API key/第三方渠道、是否人工录入订阅实付金额、是否采集远端云任务未落地的明细、是否扩展币种与历史价格表。

## 依据

- 当前仓库源码、两台机器的 Codex app-server 只读预检、元数据样本和回归测试。
- [OpenAI App Server](https://learn.chatgpt.com/docs/app-server)：账户与额度读取、完整快照与通知。
- [订阅用量说明](https://learn.chatgpt.com/docs/pricing)：订阅窗口与产品范围。
- [API 定价](https://developers.openai.com/api/docs/pricing)：价格表版本 `openai-standard-2026-10-18`。未来模型、价格与协议变化需更新映射和 fixtures。
