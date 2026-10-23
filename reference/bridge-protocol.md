# UNagent Connect protocol notes — distribution 0.1.0

Transport protocol version remains 1. The CLI sends authenticated POST /v1/calls with instanceId, method, params and idempotencyKey, then reads its transport receipt. The bridge validates method and identity; params cannot choose another caller identity. The full backend implementation is not distributed here.

Baseline methods: models.list, agents.list, sessions.list/create/update/send, tasks.get/wait/answer/cancel.

Backend extension methods coordinated with Hooke: participants.list, participants.send, inbox.list, inbox.claim, inbox.complete, inbox.fail, inbox.question, sessions.read. CLI `call METHOD` passes JSON without a local method allowlist. Backend owners define and validate parameter/result fields; METHOD_NOT_FOUND means that backend version does not support the operation. Do not invent parameters, lease identifiers or results. participants.list discovers entries, participants.send delivers work, inbox.list discovers work, claim must succeed before execution, complete/fail/question use the backend-returned task and claim identity. sessions.read is authorized reading only, not general vault access.

Read methods and durably deduplicated sessions.send / participants.send can replay automatically after bridge restart, preserving the same outer and business idempotency key. Other mutations remain conservative: uncertain outcomes return OUTCOME_UNKNOWN and are not automatically replayed. Query actual state before deciding on a new operation. Never turn a question into user approval.

All content enters through --params-file FILE or --params-file - (stdin); never interpolate user text into a shell command. Receipt is not completion. Tokens and local configuration are never release assets.

## Frozen backend parameters (controller handoff)

- participants.list: `{}`.
- participants.send: `{target:{kind:'internal',sessionId}|{kind:'external',clientId},kind:'task',content,idempotencyKey,dependencyTaskIds?}`. Internal message remains compatible with sessions.send. External clients cannot dispatch to external clients.
- inbox.list: `{}`; authenticated recipient only; safe task snapshot plus content.
- inbox.claim: `{taskId,idempotencyKey}` → `{task,content,executionToken,answer?}`.
- inbox.complete: `{taskId,executionToken,result}`.
- inbox.fail: `{taskId,executionToken,error}`.
- inbox.question: `{taskId,executionToken,questionId,text,audience?:'origin'|'user',options?}`.
- inbox.heartbeat: `{taskId,executionToken}`; renew while executing according to backend lease response.
- sessions.read: `{sessionId,cursor?,limit?,maxChars?}`. External clients can read only shared collaboration sessions; reader applies paging and safe content projection.

Keep executionToken private to the executing worker. Old tokens are fenced. Same-token same-content complete/fail are retryable at business level; generic CLI still refuses automatic replay after transport restart. Actor identity is authenticated client.actorId, never self-reported params.
