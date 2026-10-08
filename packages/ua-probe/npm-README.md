# @zack-will/ua-probe

[UsageAccumulator](https://github.com/Zack-Will/UsageAccumulator) 的探针：增量读取本机 `~/.claude/projects/**/*.jsonl`，
把 Claude Code 的用量元数据（token 数、模型、项目、时间）上报到你自建的服务端。**不上报任何 prompt、回复或工具参数。**

需要 Node.js ≥ 22.13，支持 macOS 与 Linux。

## 安装与配对

```bash
npm i -g @zack-will/ua-probe

# ① 用服务端的 UA_ENROLL_TOKEN 换取本机专属 token，写配置（~/.config/ua-probe/config.toml）
ua-probe install --server https://ua.example.com --enroll-token <UA_ENROLL_TOKEN> --no-service

# ② 首次导入历史记录（限速上报）
ua-probe backfill

# ③ 装成常驻服务：macOS → launchd，Linux → systemd user service
ua-probe install
loginctl enable-linger $USER     # 仅 Linux：否则 SSH 断开后探针会被杀

ua-probe status
```

请用全局安装，不要用 `npx` 跑 `install`：常驻服务会记下探针的路径，npx 缓存一清服务就起不来。

升级：`npm i -g @zack-will/ua-probe@latest`，然后重启服务
（macOS `launchctl kickstart -k gui/$(id -u)/com.ua.probe`，Linux `systemctl --user restart ua-probe`）。

完整的配置说明、多订阅归属与各端配对见[项目 README](https://github.com/Zack-Will/UsageAccumulator#readme)。
