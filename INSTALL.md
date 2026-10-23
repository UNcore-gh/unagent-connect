# 安装 UNagent Connect 0.1.1

唯一发布来源：https://github.com/UNcore-gh/unagent-connect/releases/tag/0.1.1 。未发布时停止，不改用源码仓或 latest。

需要 Node.js 18+。下载 `unagent-connect-0.1.1.tar.gz` 和同一 Release 的 `SHA256SUMS`，在空目录运行 `shasum -a 256 -c SHA256SUMS`，通过后才解压。进入解压目录，再运行 `shasum -a 256 -c SHA256SUMS`；校验失败停止。SHA256 用于检测损坏，可信来源仍是固定 GitHub Release。

先查看差异：

```sh
node scripts/install.mjs --target codex
node scripts/install.mjs --target claude
node scripts/install.mjs --target-dir /absolute/path/to/skills
```

选择一种目标，检查输出后给原命令加 `--apply`。默认分别为 `~/.agents/skills/unagent-connect` 与 `~/.claude/skills/unagent-connect`。自定义目录是技能父目录。已有内容不同或有本地新增文件，一律拒绝覆盖；先人工备份并移走旧目录，或另选空目录。不会修改其他配置，也不会自动更新 Node。

安装后阅读 SKILL.md：启动本机桥接、生成插件配对码，在 Obsidian「外部 AI 通讯」配对，再创建单独的客户端配对码。凭据不进入提示词或 GitHub。配对完成后用 CLI status 和实际只读调用分别确认桥接、插件和客户端联系。

配对前为入口选择易识别的名称与用途，例如名称 Codex-work、用途“代码检查”。注册命令为 `./scripts/unagent-connect client-register --name Codex-work --purpose 代码检查`，用途可省略。配对码通过交互输入或 --code-file 提供，不写进提示词或 shell 历史。更改已配对用途不会自动覆盖旧身份，请通过宿主撤销、重新配对。此包沿用同目录 LICENSE，公开通讯包不代表源码获得开源授权。
