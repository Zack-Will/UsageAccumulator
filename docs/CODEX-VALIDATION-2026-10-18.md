# Codex 首期验收记录

时间：2026-10-18 02:57（Asia/Shanghai）。分支 `codex/codex-usage-backend`，基线 `052ff8b`。只发布 Codex 模块和必要入口变更；工作区并行的 UI、Claude ACK、时区预测等变更未纳入发布。

## 验证

- 干净发布暂存目录中 core、probe、server typecheck 全通过。
- 单元/回归：core 105、probe 184、server 235，共 524 项通过（含 SSE）。11 项需数据库配置的测试在本地跳过。
- home-center PostgreSQL：独立 `codex_test_*` schema 的 3 项真实测试通过，覆盖并发去重、账号冲突回滚、迁移幂等、完整快照更新；测试 schema 已清理。
- 服务端部署前保存源码、环境配置和 85,128,035 字节的 PostgreSQL 备份。部署目录 `deploy/backups/codex-20261018-025556`（home-center）。
- Mac launchd 与 home-center systemd 独立 Codex worker 已启用，均完成真实后台同步。原 `ua-server`、`ua-probe` 继续运行，旧 Claude 额度采样成功，原 2 个 profile 可查询。
- worker bundle SHA256：`9ba192f2fd47beb603cd63eefd1c602c71ac050013eb041db71d9b5896da5e42`。

## 首轮回填快照

统计起点为上海时间 2026-10-01 00:00，查询截止 2026-10-18 02:56:51。数据随五分钟采集继续增长，以下不是永久总数。

| 指标 | 首轮结果 |
|---|---:|
| Mac 扫描文件 / 新事件 | 24 / 770 |
| home-center 扫描文件 / 新事件 | 105 / 4,807 |
| 全局唯一事件 | 5,577 |
| input / output token | 484,909,520 / 2,177,138 |
| 总 token（input + output） | 487,086,658 |
| 已定价部分 USD API 等价估值 | 329.032891 |
| 已定价事件 / 未定价事件 | 3,143 / 2,434 |
| 已定价 token 覆盖率 | 66.3050% |
| 事件冲突 | 0 |
| 历史扫描警告 | 7 |
| 首轮待发事件 / 快照 / 隔离快照 | 0 / 0 / 0（两个节点均如此） |

未定价记录模型为 `codex-auto-review`，不猜测其基础模型或价格。已定价模型为 `gpt-6-astra` 与 `gpt-6.1-sol`。`pricing_complete=false`、`usage_complete=false`、`cost_complete=false` 已通过 API 返回，不能把当前金额当完整消费总额或订阅实付。

实际本地记录最早为 10 月 9 日；10 月 1 日起没有记录的日期表示未观测到，不证明消费为零。官方摘要返回 12 个日桶，累计 831,408,337 token；它与本地覆盖范围不同，单独存储、不相加。当前额度为 7 天窗口，首次验证已用 51%，双节点快照均未过期。历史额度快照从本次启用后开始累积，无法回推 10 月 1 日的额度状态。

接口契约见 [CODEX-API.md](./CODEX-API.md)，部署与运行见 [CODEX-DEPLOYMENT.md](./CODEX-DEPLOYMENT.md)。
