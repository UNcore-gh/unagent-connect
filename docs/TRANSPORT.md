# HTTP / CLI / MCP 接线与边界

本文件记录外壳实现，不改动冻结的 HUB-CONTRACT 与 ADAPTER-CONTRACT。

`createHubServer({hub,port,stateDir})`（也导出别名 `createServer`）返回 `{server,origin,listen(),close()}`。仅监听 127.0.0.1，Host 必须精确等于监听后的 `127.0.0.1:端口`，有 Origin 时必须精确等于当前服务 origin。浏览器 Cookie 的写请求和登录必须携带 Origin，拒绝跨站 Fetch。无跨域响应头。资源启用禁止内联脚本的 CSP，用户内容仅以 textContent / value 插入。

监听成功后调用 `hub.setUrl(origin)`，把 `{url,adminToken,pid,version}` 原子写入 stateDir/connection.json（目录 700，文件 600）。关闭时仅删除自己写入且内容一致的连接文件；CLI 随后 await hub.close()。不会读取插件 data.json。

POST /v1/login 用本机管理员令牌换 HttpOnly、SameSite=Strict、8 小时 Cookie；上限 128 会话、登录每分钟 30 次。每个 Cookie 请求都重新 authenticate，Cookie 不向模型暴露。POST /v1/logout 同源清 Cookie。管理员 Bearer 兼容冻结 HTTP 契约，限本机使用；MCP 客户端固定附加 X-UNagent-Connect-Client:mcp，服务端拒绝该通路的管理员身份。所有业务 RPC await hub.call(method,params,actor)，actor 只来自 authenticate(token)，不信任请求参数中的身份。

JSON 请求上限 1MiB（同时校验声明长度与实际流），请求必须为 JSON 对象。GET /v1/health 只返回版本。GET /v1/events 返回统一 `{ok:true,result:{events,nextCursor}}`；SSE 的事件名为 hub，data 是该批 events/nextCursor，id 是 nextCursor。after 是非负安全整数，重连优先 Last-Event-ID。单批用 Hub 默认 100 条过滤事件，拒绝超过 1000 条或 1MiB 的异常批次。最多 32 个流连接，每连接最多 5 分钟，15 秒保活，背压时断开，客户端携带游标续接。subscribe 触发异步刷新，断线解绑；保活时重认证并补查，撤销凭据不能继续取数据。浏览器 EventSource 自动重连，管理页只保留最近 100 条事件。

CLI `status` 只查健康状态，无需适配器或认证；管理操作在本机 UI 完成。`serve` 动态导入 Hub 和可用适配器模块，MCP 仅在 mcp 命令加载 SDK，原生 SDK 必须由适配器按选中入口延迟加载。`legacy` 使用 spawn(process.execPath, argv, shell:false) 转发原 CLI，参数不拼命令字符串。

MCP 使用已安装的官方 SDK stdio transport，stdout 只保留协议。开放参与者消息、会话、收件箱、任务、澄清、事件工具；无管理员工具。JSON Schema additionalProperties:false 及程序校验均拒绝 token/senderId/parentRunId 等身份覆盖。受管理环境的可信 parentRunId/executionToken 注入 runs.submit、runs.wait；两环境变量缺一则启动失败。runs.wait 每次最多 25 秒，程序内部继续直到 terminal/input/deadline（最多 30 分钟）或取消。HTTP 错误直接报告，不自动重放未知业务操作。调用方的 MCP request timeout 应允许长任务等待；外壳不修改宿主全局配置。

安装源通过显式白名单收集；依赖闭包来自当前已安装 package manifests，无网络请求和 npm lifecycle。源码 `scripts/generate-unagent-connect.mjs` 保留原分发生成器命令作为 package.mjs 的兼容入口。旧测试路径从旧 `integrations/unagent-connect` 调整为独立根目录，保留原断言与用例。
