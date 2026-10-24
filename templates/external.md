---
name: unagent-connect
description: Use the local UNagent Connect hub for participant messages and tasks over CLI or MCP, or use an explicitly paired legacy UNagent Obsidian bridge. Does not install services or configure global MCP automatically.
metadata:
  short-description: Connect to a paired UNagent plugin
---

# UNagent Connect

## 先确认使用哪一条连接

独立 Hub 使用 `bin/connect.mjs`（Node.js 22.13+，默认端口 18492）；原 0.1.1 桥接使用 `scripts/unagent-connect`（Node.js 18+，默认端口 27123）。已配对的旧连接沿用，不自动迁移、重新配对或修改用户全局 MCP/后台服务。以下「First connection」及其旧命令只适用于原 bridge。

### 独立 Hub

- 已有服务时先 `node bin/connect.mjs status`，使用用户指定的参与者令牌及项目。管理页由本机用户创建参与者并设置可通信对象，自动执行默认关闭；不能索取、读取或转发管理员 connection.json/令牌来获得管理权限。
- CLI 调用为 `node bin/connect.mjs rpc METHOD --params-file ./params.json --token-file /私有路径/participant.token`；stdin 用 `--params-file -`。正文写入 JSON，不拼 shell。先 `participants.list` 获取精确 ID，`messages.send` 仅发消息，用户明确派活时才 `runs.submit`。重试复用同一幂等键；回执不是完成。
- MCP 使用 `node bin/connect.mjs mcp`，从 `UNAGENT_CONNECT_TOKEN_FILE` 或 `UNAGENT_CONNECT_TOKEN` 取参与者认证，URL 使用 `UNAGENT_CONNECT_URL`。工具参数不能覆盖身份或注入管理员操作。
- 受管理 MCP 的父任务和执行凭证来自 `UNAGENT_CONNECT_RUN_ID`、`UNAGENT_CONNECT_EXECUTION_TOKEN`，由程序注入派发和等待。使用 `connect_runs_wait` 等待子任务；程序处理每次最多 25 秒的 RPC，直至完成、需要输入或期限，不自行重复派发来轮询。
- 审批只能由用户在本机管理页处理。澄清回答针对返回的真实 questionId；失败、interrupted、uncertain 先查看原生状态，不能自动重置或重放未知执行。
- 安装默认只展示差异，只有用户指定目标并要求安装时才加 `--apply`。校验和不符或目标已有修改时停止，保留现有文件，选择新的目标或交由用户比较。完整参数见 [README.md](README.md)，接口见 [docs/HUB-CONTRACT.md](docs/HUB-CONTRACT.md)。


Use this skill when an external agent needs to call a user's explicitly paired UNagent plugin. This skill uses only the local bridge CLI and the selected instance; it does not read Obsidian settings, Vault notes, plugin `data.json`, or API keys.

## First connection

1. Check that Node.js 18 or newer is already available with `node --version`. If it is missing, tell the user to install or enable Node.js themselves. Do not install it automatically.
2. Run `./scripts/unagent-connect start`, then check `status`. If the plugin has not been paired yet, run `./scripts/unagent-connect pair-code`. Paste the returned short-lived code into Obsidian 设置 → 通用 → 外部 AI 通讯 → Pair. The default bridge address is `http://127.0.0.1:27123`; the user may have explicitly configured another loopback port.
3. In that plugin's Bridge settings, create a client pairing code. Run `./scripts/unagent-connect client-register --name <stable-client-name> --purpose <short-purpose>` and paste the prompted code. Ask the user for a recognizable name and short purpose (for example, name Codex-work, purpose code review). --purpose is optional; never invent one. Use the same stable name on later runs; CLI credentials are stored with restrictive file permissions under `~/.unagent/bridge/clients/`.
4. Run `./scripts/unagent-connect list-instances`. Select the exact `instanceId` the user wants. Every business call must pass it explicitly.

`pair-code` registers a plugin host. The settings page creates a separate one-use client code. A client token cannot create pairing codes, list other instances, or revoke identities.

## Calling UNagent

Methods require matching backend support; METHOD_NOT_FOUND means unavailable, never success. Supported baseline methods are `models.list`, `agents.list`, `sessions.list`, `sessions.create`, `sessions.update`, `sessions.send`, `tasks.get`, `tasks.wait`, `tasks.answer`, and `tasks.cancel`.

Pass JSON through a file or standard input so message text does not need shell escaping:

```sh
./scripts/unagent-connect call sessions.list \
  --instance INSTANCE_ID --client stable-client --idem list-20261021-01

./scripts/unagent-connect call sessions.send \
  --instance INSTANCE_ID --client stable-client \
  --idem send-20261021-01 --params-file ./send-params.json
```

`sessions.send` returns only after the plugin dispatch acknowledges the business operation. For a task, save `result.task.id` as the business task ID; the bridge's `callId` is only a short-lived transport ID. Receipt means accepted, not completed. The CLI requires a stable `--idem` for every call. Delivery via `sessions.send` and `participants.send` has durable plugin-side deduplication. Both inject --idem as params.idempotencyKey and reject a conflicting inner key; reuse the same key after bridge restart. Other mutations use the bridge's temporary transport cache; after a bridge restart, inspect the current session/task state before repeating them, especially `sessions.create`, which could create another chat.

Use `wait TASK_ID`, `answer TASK_ID`, or `cancel TASK_ID` to work with the business task. `answer` reads parameters from `--params-file` or stdin. For `tasks.get`, pass a JSON file such as `{"taskId":"..."}` to `call tasks.get`.

If a call times out, the CLI returns its temporary transport `callId`. While the bridge process remains up, resume with `call --request-id CALL_ID --instance INSTANCE_ID --client stable-client`. If the bridge restarted, retry a delivery with the same `--idem`; if the business task ID is already known, query using `tasks.get` or `wait`. If a delivered call was disconnected before acknowledgement, its business effect may already have happened. The CLI reports non-idempotent outcomes as unknown instead of replaying them. Inspect current state before issuing a new mutation. Do not treat an HTTP `202` or a queued transport entry as business success.

When `wait` returns `waiting_origin`, answer its exact question ID using `answer`. When it returns `waiting_user` or `interrupted`, tell the user to handle confirmation or recovery in Obsidian; do not answer on their behalf or treat a clarification as permission. Bounded waits can time out while the task continues: keep its original task ID and wait/query again, never create a replacement task to poll for progress.

## Safe operating rules

- Use the instance id selected by the user. Never probe other instance ids.
- Reuse the same `--idem` when retrying the same mutation. Choose a new id for a genuinely new action.
- Use the stable client profile name supplied at registration. Client identity is authenticated by the saved token, not by a name in request parameters.
- Pair codes expire after five minutes. Do not put pairing codes or tokens in URLs, skill files, notes, logs, or shell scripts.
- `stop` shuts down the user's local bridge. Run it only when the user explicitly asks to stop the service.
- For command parameters, result shapes, and lifecycle details, read [reference/cli.md](reference/cli.md).

## 外部参与者与收件箱

后端提供后可用 call 调用 participants.list/send、inbox.list/claim/complete/fail/question/heartbeat、sessions.read。先 participants.list 发现入口；inbox.list 查看待办，领取成功后才工作，使用后端返回的任务及领取标识提交结果。question 是工作澄清，不是用户审批。领取返回 executionToken；执行中用 inbox.heartbeat 续租，完成、失败和提问都携带该凭证，旧凭证不可复用。参数见 reference/bridge-protocol.md，sessions.read 使用 sessionId、可选 cursor/limit/maxChars，只可读开放协作会话。外部客户端不能派给其他外部客户端。所有正文写 JSON 文件或标准输入（--params-file -），不要拼进 shell 命令。

{{SHARED}}

## 手动接活后的有限续租

这不是常驻 worker。用户手动让外部 AI 接活、inbox.claim 成功后，如果工作可能超过默认 60 秒租约，立即在独立终端启动续租助手：

```sh
./scripts/unagent-connect heartbeat --instance INSTANCE_ID --client stable-client --params-file ./lease.json --duration-ms 900000
```

lease.json 只放当前领取返回的 taskId 和 executionToken，私有保存、不进聊天或版本库；也可用 --params-file - 经 stdin 传入。助手立即续租，之后每 20 秒一次；单次调用最多 10 秒，任一失败立即停止、不重试。默认 15 分钟，最长 1 小时；到期停止，不能建议无限循环自动重启。关注助手退出结果，失败后暂停工作并查看真实任务状态，不把本地产出当已提交。

工作完成、失败或提问时先停止助手（终端 Ctrl+C，或向它输出的 PID 发送 SIGTERM），再提交对应 complete/fail/question。停止助手不会停止桥接，也不会自动完成任务。提问获答后需重新 claim，拿新 executionToken 再按需启动；租约超时会 interrupted，必须由用户在宿主界面重置，不自动抢回或新建替代任务。
