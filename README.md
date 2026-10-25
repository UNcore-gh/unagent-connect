# UNagent Connect

独立运行在本机的协作入口：中文管理页、HTTP RPC、命令行与 MCP。仅分发通讯包、Hub 与公开适配器，不包含 Obsidian 私有插件源码、笔记、配置或凭据。原 0.1.1 通讯脚本、配对和技能工作流继续保留。

需要 Node.js **22.13 或更新版本**。旧版 `scripts/unagent-connect` 保持原有 Node.js 18 要求。保留原 UNcore 专有软件许可协议，详见 [LICENSE](LICENSE)。

```sh
node bin/connect.mjs serve
node bin/connect.mjs status
```

启动后打开终端输出的 `http://127.0.0.1:18492`。默认状态目录为 `~/.unagent/connect`，其中 `connection.json` 为 600 权限私有文件，包含管理员令牌。手动粘贴到管理页登录，令牌不进入网址或浏览器持久存储。可以使用 `serve --port 18493 --state-dir /绝对路径` 建立独立实例；不会关停旧服务、自动安装后台服务或修改全局 MCP 设置。

在管理页创建参与者，选已有项目目录、用途、可通信对象和入口配置。自动执行默认关闭。管理员身份只供本机管理；为外部 AI 单独保存参与者令牌，不能给它管理员凭据。工作区与会话绑定规则由 Hub 和各入口检查。普通消息只投递，任务才进入执行队列。

## CLI 与 MCP

把参数写进 JSON 文件或标准输入，不把用户正文拼进 shell：

```sh
node bin/connect.mjs rpc participants.list --params-file - --token-file /私有目录/participant.token
node bin/connect.mjs rpc runs.submit --params-file ./task.json --token-file /私有目录/participant.token
node bin/connect.mjs mcp --token-file /私有目录/participant.token
```

RPC 默认从 stdin 读取 JSON；无参数可输入 `{}` 后结束输入。令牌文件应为 600 权限普通文件，可保存纯令牌或 `{ "token": "…" }`，拒绝把管理员连接文件当参与者配置。`--url` 或 `UNAGENT_CONNECT_URL` 只能指定 `http://127.0.0.1:端口`。环境也支持 `UNAGENT_CONNECT_TOKEN_FILE` 或 `UNAGENT_CONNECT_TOKEN`。

MCP 工具不提供创建、修改、撤销参与者、重置任务或系统管理能力。误配管理员凭据时，HTTP 层拒绝 MCP 调用。受管理的 MCP 自动读取 `UNAGENT_CONNECT_RUN_ID` 与 `UNAGENT_CONNECT_EXECUTION_TOKEN`，注入子任务派发和等待；模型不能覆盖。等待工具在程序内部重复有界 RPC，直到任务终止、需要输入、任务期限或最多 30 分钟；不会自动重发任务。需要人工确认时回到管理页处理。

## 旧版兼容

旧版命令仍可原样使用：

```sh
./scripts/unagent-connect start
./scripts/unagent-connect pair-code
./scripts/unagent-connect client-register --name my-client --purpose 代码检查
# 或从统一入口转发
node bin/connect.mjs legacy list-instances
```

旧版默认端口 27123，独立 Hub 默认端口 18492，两个身份系统互不替代。已安装的 0.1.1 skill 不会被自动更改。配对、任务等待及有限续租说明见 [reference/cli.md](reference/cli.md) 与 [SKILL.md](SKILL.md)。

## 安装、打包与检查

运行源码目录前先安装项目声明的依赖；已构建的分发目录包含运行依赖，不需要再次联网安装。

```sh
node scripts/package.mjs --out /临时目录/connect-build
node /临时目录/connect-build/unagent-connect/bin/connect.mjs status
node /临时目录/connect-build/unagent-connect/scripts/install.mjs --target codex
# 查看差异后再显式落盘
node /临时目录/connect-build/unagent-connect/scripts/install.mjs --target codex --apply
node scripts/check.mjs
```

每次打包选择新的输出目录，拒绝覆盖旧包。源码目录也支持 `node bin/connect.mjs install --target codex`，先在临时目录构建同样的独立包再展示差异。安装详细行为见 [INSTALL.md](INSTALL.md)，安全、SSE 和接线说明见 [docs/TRANSPORT.md](docs/TRANSPORT.md)。冻结协议为 [Hub](docs/HUB-CONTRACT.md) 与 [Adapter](docs/ADAPTER-CONTRACT.md)。

## 可选 Claude 运行依赖

开发源码安装基础服务用 `npm ci --omit=optional --ignore-scripts`。默认分发包只包含 Hub/MCP 所需依赖，不包含 Claude SDK；Codex 使用本机已有命令，WorkBuddy/Harness 使用用户现有原生连接器。

要制作含 Claude 自动执行能力的本机包，维护者先按锁文件安装可选依赖，再执行 `node scripts/package.mjs --out /新的空目录 --adapters claude`。也可在服务自己的安装目录显式安装 `@anthropic-ai/claude-agent-sdk@0.2.141`；这不会配置账号或更改其他 Agent 的设置。只有对应入口开启自动执行时才启动原生进程。

## 验收边界

0.2.1 为本轮正式修复包；查看 [支持与实测矩阵](docs/SUPPORT.md)。已跑通真实 UNagent → Codex → Claude → UNagent 往返，WorkBuddy 原生回复及原任务回读恢复。Harness 本机缺少已注册桥接且当前 App 版本不在已验证范围，因此明确未验收，不自动修改 profile。

遇到 interrupted/uncertain，先在管理页“查询原执行结果”，只查保存的原生编号，不重派。适配器不支持查询时会明确拒绝；确认原执行已停止后才考虑重置。
