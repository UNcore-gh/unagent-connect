# UNagent Connect CLI reference

The CLI is implemented with Node.js built-ins only. Run it from the installed skill directory as `./scripts/unagent-connect <command>` (or `node scripts/unagent-connect.mjs <command>`). The wrapper reports a clear JSON error when Node.js is missing. It starts the bridge automatically for `pair-code`, `client-register`, `list-instances`, and business calls. It never installs Node.js or chooses a replacement port.

## Commands

| Command | Use |
| --- | --- |
| `start [--port PORT | --address http://127.0.0.1:PORT]` | Start the local bridge. Default port is 27123. A changed port is saved under `~/.unagent/bridge/bridge-config.json`; stop the old service before changing ports. |
| `status` | Read local bridge status without starting it. |
| `stop` | Stop the verified local bridge process. Only run when the user asks. |
| `pair-code` | Start the service if needed and issue a five-minute code for pairing an Obsidian plugin instance. |
| `client-register --name NAME [--purpose PURPOSE] [--profile PROFILE] [--code-file PATH|-]` | Register one external client with the separate client code created in the plugin settings. If no code source is given, the CLI prompts in a terminal or reads stdin. |
| `list-instances` | List instance ids and online status; always choose one exact id for calls. |
| `call METHOD --instance ID --client PROFILE --idem KEY [--params-file PATH|-] [--timeout-ms MS]` | Call an allowlisted business method. Default wait is 120 seconds; maximum is ten minutes. |
| `call --request-id ID --instance ID --client PROFILE [--timeout-ms MS]` | Resume reading the short-lived transport status while the same bridge process still holds it. |
| `wait TASK_ID --instance ID --client PROFILE [--timeout-ms MS] [--idem KEY]` | Wait on an existing business task id. It creates bounded `tasks.wait` calls and continues from the same task id after a disconnect. |
| `answer TASK_ID --instance ID --client PROFILE --params-file PATH --idem KEY` | Answer an existing task. The CLI adds the task id and business idempotency key. |
| `cancel TASK_ID --instance ID --client PROFILE --idem KEY` | Cancel an existing task through UNagent. |

All machine-readable responses are one JSON object per line. Errors go to stderr as JSON. `callId` is a bridge transport id and expires with the in-memory cache; `taskId` is the business task id owned by UNagent.

## Parameter input

Use `--params-file ./params.json` or pipe JSON to `--params-file -`. Parameter files must contain a JSON object and be no larger than 1 MiB. The CLI's local idempotency index stores only a fingerprint, method, instance id, idempotency value, and transport call id; it does not copy parameter bodies or business results.

For `sessions.send`, `--idem` is copied into `params.idempotencyKey`. If the supplied JSON already has a different key, the CLI stops with an idempotency conflict. Other mutations use `--idem` only for in-process bridge deduplication; after a bridge restart, or when a delivered call was cancelled before acknowledgement, the CLI refuses to replay an outcome-unknown mutation and directs the caller to inspect session/task state first.

## Local files and restart behavior

The user directory is fixed at `~/.unagent/bridge`. The CLI has an isolated test-only path override that is honored only when `NODE_ENV=test`; it is not a user configuration. Directories use mode `0700`; credential files use mode `0600`. No token is printed by status, list, call, or task commands.

The bridge persists identity and pairing metadata only. Pending request bodies, delivery state, call results, and transport idempotency indexes stay in memory and expire after 15 minutes; there are at most 1,000 cached calls and 64 pending calls. A bridge restart clears this transport cache. Retrying `sessions.send` with the original `--idem` lets UNagent recover its durable receipt; once known, query with the original task ID. For other mutations, inspect current state before repeating after a bridge restart. In particular, `sessions.create` does not have a durable creation receipt.

## Business parameters and results

Successful `call` responses have transport `status: "completed"` and a business value in `result`. Read these shapes from that value:

| Method | Parameters (besides CLI-injected idempotency keys) | Business result |
| --- | --- | --- |
| `models.list` | `{}` | Array of `{id,label,providerId,capabilities}`; no secrets |
| `agents.list` | `{}` | Array of available agents with `id` and descriptions |
| `sessions.list` | `{}` | Array of shared sessions with stable `id`, title, model and state |
| `sessions.create` | `{title?,modelId,agentId?,purpose?}` | Shared session; save its `id` |
| `sessions.update` | `{sessionId,title?,purpose?,modelId?}` | Updated session; model changes reject while busy |
| `sessions.send` | `{sessionId,content,kind:"task"}` or `kind:"message"` | Task receipt: `{kind:"task",task:{id,...},reused}`; message receipts do not start a model |
| `tasks.get` | `{taskId}` | Task snapshot with `status`, optional `question`, `result`, `error`, `actualModelId` |
| `tasks.wait` | `{taskId,timeoutMs?}` or `{taskIds:[...],timeoutMs?}` | Status plus `tasks`; an origin clarification also includes `taskId` and `question` |
| `tasks.answer` | `{taskId,questionId,answer:"text"}` | Accepted task snapshot; only answers the exact open origin question |
| `tasks.cancel` | `{taskId}` | Cancelled or already terminal task snapshot |

Example `send-params.json`:

```json
{"sessionId":"SESSION_ID","kind":"task","content":"请整理这份资料，并在需要补充信息时向我提问。"}
```

After saving `result.task.id`, use `wait TASK_ID`. `waiting_dependency` means work continues; `waiting_origin` asks for a clarification, with `question.questionId`, `text` and optional `options`. `waiting_user` and `interrupted` require the user to act in Obsidian. Only `completed` means a final result is available. Timeouts end the query, not the task.

If Node.js is unavailable, report that clearly and let the user install or enable it. The skill never installs runtimes or dependencies.

## Bounded heartbeat helper (manual work only)

`heartbeat --instance ID --client PROFILE --params-file FILE|- [--duration-ms MS]` reads `{taskId,executionToken}` from file/stdin. It renews immediately and every 20 seconds, stops at the first error, and never retries. Each child call times out after 10 seconds. Default lifetime: 900000 ms (15 min); allowed: 1000..3600000 ms (1 hour). Keep it in a separate terminal during claimed work. Stop with Ctrl+C or SIGTERM to the PID printed on stderr; no credential appears in that message. Stop before complete/fail/question. This does not stop the bridge or submit business results. After question is answered, claim again to obtain a fresh executionToken. Expired leases need host UI reset, not automatic reclaim. No unattended restart loop.

`--name` 是稳定且可识别的客户端名称，`--purpose` 是可选的简短用途，随注册 body.purpose 提交给后端；用途不参与身份认证。已配对 profile 的用途不同会拒绝静默覆盖，需由用户通过宿主撤销并重新配对。
