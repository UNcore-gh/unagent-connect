# 本机安装与分发

独立服务需要 Node.js 22.13+；本工具不安装 Node.js，不写用户 MCP 配置，不安装或修改 LaunchAgent，不停止已有服务。保留原 LICENSE。

1. 源码由项目维护者安装 `package.json` 中的依赖后，运行 `node scripts/package.mjs --out /绝对路径/空输出目录`。产物位于其 `unagent-connect/` 子目录。构建只收集白名单源码与已安装的运行依赖，不启动任何原生执行入口，也不执行 npm 生命周期脚本。原生 SDK 在选中对应入口时才加载。内含的原生依赖随构建机器平台，跨系统构建应在目标平台重新打包。
2. 在产物目录运行 `node scripts/install.mjs --target codex` 预览差异。Codex 默认目标 `~/.agents/skills`，Claude 默认 `~/.claude/skills`。其他宿主必须指定 `--target other --target-dir /绝对路径/skills`；也可覆盖前两种默认路径。最终安装目录是目标下的 `unagent-connect`。
3. 确认目标和差异后，加 `--apply`。不带该参数时不会创建或修改目标目录。源码的 `node bin/connect.mjs install ...` 会先在系统临时目录构建独立包，结束后清理该临时包。
4. 安装前校验每个文件的 SHA-256，拒绝符号链接、目录穿越、被改动的分发文件。已有目标只要与待装包不同，就拒绝覆盖，包括本地修改、额外文件和不同版本。为新版本选择新目标目录，保留旧安装，人工比较后再切换；不自动迁移凭据。

旧版 0.1.1 技能及 `scripts/unagent-connect` 的配对继续可用。安装不会读取或改写旧 bridge 的用户配置。不要把 Hub 管理员令牌交给模型；新参与者凭据仅本次显示，私下保存到 600 权限文件，通过 MCP 环境或 `--token-file` 引用。

可直接移动整个构建产物目录再运行 `node bin/connect.mjs serve`。无需 Obsidian 插件仓库或源码仓库，MCP 运行依赖包含在包中；各原生入口仍需用户已安装并授权对应原生应用或连接器。管理页的“检查入口状态”会报告缺少配置或不兼容，不代表任务已执行成功。

分发白名单包括 `src/**/*.mjs`、入口脚本、必要文档、技能、agents 元数据、原 LICENSE 与已安装的依赖闭包。不包含测试、状态目录、日志、`.env`、`data.json`、私有插件源码、令牌或数据库。SHA256SUMS 检测损坏与本地变更，并非数字签名；只从信任的来源取得完整分发包。

## 可选 Claude 运行依赖

开发源码安装基础服务用 `npm ci --omit=optional --ignore-scripts`。默认分发包只包含 Hub/MCP 所需依赖，不包含 Claude SDK；Codex 使用本机已有命令，WorkBuddy/Harness 使用用户现有原生连接器。

要制作含 Claude 自动执行能力的本机包，维护者先按锁文件安装可选依赖，再执行 `node scripts/package.mjs --out /新的空目录 --adapters claude`。也可在服务自己的安装目录显式安装 `@anthropic-ai/claude-agent-sdk@0.2.141`；这不会配置账号或更改其他 Agent 的设置。只有对应入口开启自动执行时才启动原生进程。
