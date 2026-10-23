# UNagent Connect 0.1.0

让 Codex、Claude 和其他支持 skill 的外部 AI，通过本机桥接与 Obsidian 中的 UNagent 配对、通讯和协作。

**此公开仓仅分发通讯包**：skill、命令行工具、本机桥接、协议说明和使用文档。它不包含 UNagent 插件完整源码、模型服务、用户笔记、配置或凭据。通讯包沿用项目原有的 **UNcore 专有软件许可协议（Source Available License）**，详见 [LICENSE](LICENSE)。公开可查看不等于开源，不改为 MIT，也不额外授予原许可之外的权利。

## 安装

需要 Node.js 18 或更新版本。固定下载入口为 [0.1.0 Release](https://github.com/UNcore-gh/unagent-connect/releases/tag/0.1.0)。若该版本尚未发布，请停止并等待发布。

下载压缩包和 SHA256SUMS，先验证压缩包 SHA256，通过后再解压，并验证包内逐文件校验。完整步骤见 [INSTALL.md](INSTALL.md)。

进入已校验的解压目录，选择一个目标，先看差异：

```sh
node scripts/install.mjs --target codex
node scripts/install.mjs --target claude
node scripts/install.mjs --target-dir /absolute/path/to/skills
```

确认后给所选命令加 `--apply`。Codex 默认使用 `~/.agents/skills/unagent-connect`，Claude 默认使用 `~/.claude/skills/unagent-connect`。自定义参数是技能父目录。已有修改会拒绝覆盖，不修改其他工具配置。

## 首次配对

1. 阅读 [SKILL.md](SKILL.md)，启动 `./scripts/unagent-connect start`。
2. 运行 `./scripts/unagent-connect pair-code`，在 Obsidian「外部 AI 通讯」完成插件配对。
3. 在同一设置页生成外部客户端配对码，为外部 AI 选择名称和可选用途，例如：

```sh
./scripts/unagent-connect client-register --name Codex-work --purpose 代码检查
```

在交互提示中输入客户端配对码。名称用于识别入口，用途说明这项入口做什么；用途不赋予权限。不要把配对码、token 或执行凭证写进命令、笔记、公开仓或聊天。配对码不能混用。

4. 用 `list-instances` 选择用户指定的实例，再用 `status` 和实际只读请求验证连接。只联系明确授权的入口。

## 使用与手动接活

正文放 JSON 文件，用 `call METHOD --instance ID --client PROFILE --idem KEY --params-file FILE` 传入；也支持 `--params-file -` 从标准输入读。不要把任务正文拼进 shell。方法及参数见 [协议说明](reference/bridge-protocol.md) 与 [CLI 指南](reference/cli.md)。后端不支持的方法会报错，不能当作已完成。

用户手动接活并成功领取后，耗时可能超过 60 秒时，在独立终端启动有时限的续租助手：

```sh
./scripts/unagent-connect heartbeat --instance INSTANCE_ID --client Codex-work --params-file ./lease.json --duration-ms 900000
```

lease.json 私有保存领取返回的 taskId、executionToken。助手每 20 秒续租，默认 15 分钟、最长 1 小时，失败即停止、不循环重试。Ctrl+C 或 SIGTERM 停止；完成、失败或提问前停止。提问获答后重新领取新凭证，超时中断由用户在宿主界面恢复。这里没有常驻接活服务。

回执表示已接收，结果确认后才表示完成。用户审批须由用户本人处理。
