# Codex 后端部署与运行

本期保持现有项目包结构。API 契约见 [CODEX-API.md](./CODEX-API.md)。服务端的 `0005`、`0006` 为新增独立表，`0007` 只给警告表加一列，均不修改 Claude 事件或预测逻辑。部署前备份受影响源码、运行配置及数据库；失败可回退源码和环境配置，保留独立 Codex 表以免丢失采集数据。

## 配置

服务端环境增加 `UA_CODEX_ACCOUNT_EMAIL`；空值禁用 Codex 上报。邮箱只放在运行配置中。机器沿用现有注册 token，读接口使用现有只读/管理鉴权。

采集器推荐单独的 `~/.config/ua-probe/codex.toml`（权限 0600），从原配置保留 `[server]` 机器身份、项目路径哈希配置，另加：

```toml
[codex]
enabled = true
expected_email = "your-account@example.com"
binary_path = "/absolute/path/to/codex"
home = "/absolute/path/to/.codex"
state_db = "/absolute/path/to/.config/ua-probe/codex.db"
backfill_from = "2026-09-30T16:00:00.000Z"
interval_secs = 300
request_timeout_ms = 30000
account_usage = true
```

默认扫描 `<home>/sessions` 与 `<home>/archived_sessions`；可用 `scan_roots` 显式覆盖。必须是该节点的登录环境，不复制认证文件。首期历史归属采用配置绑定；所有记录带 `configured_account_history` 标记。运行账户一旦变化，采集器拒绝扫描新数据，需人工核对并迁移独立状态库，不能直接重绑旧队列。

```sh
node ua-probe.mjs codex-sync --config ~/.config/ua-probe/codex.toml
node ua-probe.mjs codex-run --config ~/.config/ua-probe/codex.toml
node ua-probe.mjs codex-status --config ~/.config/ua-probe/codex.toml
```

`codex-sync` 执行历史回填和当前快照同步，可重复执行。`codex-run` 每五分钟同步并重试离线队列。400/413/422 拒绝的快照会持久隔离，保留原始元数据以便修复，并持续报告 `codex_snapshot_rejected`；401/403/409/网络错误保留正常重试。一个状态库同时只允许一个 worker；手工同步前先停其服务。独立 worker 不管理原 Claude 探针进程。

## 构建与服务

使用 Node 22 或以上版本（需要 `node:sqlite`）。从已验证的干净源码构建：

```sh
node packages/ua-probe/scripts/bundle.mjs --out /tmp/ua-codex-bundle
```

将产物安装为 `~/.local/lib/ua-codex/ua-probe.mjs`。使用绝对 Node 路径与绝对 config 路径启动，避免后台服务 PATH 不同导致失败。

- macOS：独立 launchd label `com.ua.codex-probe`，`KeepAlive=true`，日志位于 `~/Library/Logs/ua-probe/codex-{out,err}.log`。
- Linux：独立 systemd 用户服务 `ua-codex-probe.service`，`Restart=always`、`RestartSec=10`，日志使用 journal。
- 服务端继续由现有 `ua-server.service` 运行；新迁移随启动执行。变更只涉及 Codex 模块与必要的路由/存储组合入口。
- **先升级服务端，再升级探针。** 新探针在 collector 里带 `warning_scope`，旧服务端的严格校验会以 400 拒收整批；探针不会因此隔离事件（同一信封不带事件也被拒，说明问题不在事件），只会停在重试，升级服务端后自动恢复。
- 探针解析器修订号（`CODEX_PARSER_REVISION`）进入扫描身份：升级后第一次同步会清游标重扫全部文件。已产出过的事件 id 不变，按 `event_id` 去重，不会重复入账；只补上旧版漏掉的请求（如上下文压缩那一轮）。

## 验证与数据解释

先用 `tools/codex/check.ts` 校验各节点当前登录邮箱、账户指纹、额度与官方摘要；输出不包含凭证或对话。再执行首轮回填，检查 `/v1/codex/collectors` 的两个节点、快照时间和状态，以及本地队列是否排空。

查询日期采用半开区间 `[from,to)`，默认分日时区取服务端 `UA_TIME_ZONE`（compose 缺省 Asia/Shanghai）。10 月 1 日起点必须带 UTC 偏移，不能误用 UTC 当日零点。后续 WebUI 应使用接口的金额口径、覆盖率及质量字段，不将 `cost_usd` 当订阅实付。

无新用量仍会采集额度。两节点的同一账户额度取最新完整快照；账户官方累计 token 不与本地 token 相加。历史警告和冲突不会因后续成功扫描而消失。金额支持已映射模型的标准 API 等价估算，未知模型/细分保留未知；价格版本随记录保留。

针对真实 PostgreSQL 的测试仅创建唯一 `codex_test_*` schema 后清理：

```sh
UA_TEST_CODEX_DATABASE_URL=... pnpm --filter @ua/server exec vitest run test/codex-pg-live.test.ts
```

不要用会重置 `public` schema 的其他测试连接生产数据库。
