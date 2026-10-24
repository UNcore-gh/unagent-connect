# Hub public API 0.2

HTTP all business calls: POST /v1/rpc body {method,params}. Auth Bearer participant token or local admin token; exact Host and Origin, loopback only. GET /v1/health unauthenticated contains version only. GET / is admin web UI shell; POST /v1/login exchanges local admin token for HttpOnly SameSite=Strict cookie. GET /v1/events?after=N via admin cookie/auth, bounded JSON event list; GET /v1/events/stream?after=N SSE. RPC returns {ok:true,result} or {ok:false,error:{code,message}}.

Admin methods:
- participants.create {name,provider:'manual'|'unagent'|'codex'|'claude'|'workbuddy'|'harness',workspace:absolute existing directory, purpose?,autoExecute?:false,allowedPeers?:id[],config?:object} -> {participant,token} token returned once.
- participants.update {id,name?,purpose?,autoExecute?,allowedPeers?,config?}; participants.revoke {id}; participants.rotateToken {id}.
- system.status {} -> {version,participants,runs,adapters} metadata no credentials. adapters.health {id,config?}.
- runs.recover {runId}: query saved native identifiers only, never resubmit, admin-only.
- runs.reset {runId,confirmStopped:true} -> interrupted/uncertain/cancel_requested to queued (new attempt credential on claim). No implicit retry.

Participant/admin methods:
- participants.list {} returns allowed public entries including self; no token/config.
- threads.create {recipientId,title?,idempotencyKey} -> thread (two participants). admin must provide senderId explicitly on create/send/submit; participant sender always auth bound; no actor/source override.
- threads.list {}; messages.send {recipientId,threadId?,content,idempotencyKey,senderId?} -> {message,thread}. Ordinary message never invokes executor. messages.list {threadId,after?,limit?}; messages.ack {messageId}.
- runs.submit {recipientId,threadId?,content,idempotencyKey,senderId?,parentRunId?,executionToken?,dependencyRunIds?:[]} -> run. Parent accepted only if auth recipient owns its live executionToken (admin may bind); target must share canonical workspace, be permitted peer, parent/root limits 4 hops/8 rounds/30min.
- runs.list {}; runs.get {runId}; runs.wait {runId,timeoutMs<=25000} -> run, waits for revision/terminal/input. Recipient, sender, ancestor sender/recipient can inspect related tree, not strangers.
- inbox.list {}; runs.claim {runId,idempotencyKey} -> {run,executionToken}; runs.heartbeat {runId,executionToken}; runs.complete {runId,executionToken,text,artifacts?}; runs.fail {runId,executionToken,error}.
- runs.cancel {runId}; runs.rework {runId,content,idempotencyKey} -> same run, next round, same thread and native session; sender/admin only, old round must have confirmed termination. Old credential fenced.
- questions.ask {runId,executionToken,kind:'clarification'|'approval',text,options?} -> question; questions.answer {questionId,answer?} -> accepted. approval answer {approved:boolean} admin only (local UI), never forwarded agent authority.
- events.list {after?,limit?,runId?} -> {events,nextCursor} permission-filtered. capabilities/get health report unsupported features explicitly.

Run public projection contains id,threadId,senderId,recipientId,workspace,status,round,rootRunId,parentRunId,dependencyRunIds,nativeSessionId?,result?,question?,error?,deadlineAt,createdAt,updatedAt,revision. Never executionToken/token hashes/config/checkpoints. Internal driver uses private run fields. Status queued/running/waiting_dependency/waiting_question/waiting_approval/completed/failed/cancel_requested/cancelled/interrupted/uncertain/paused.

MCP names: connect_participants_list, connect_threads_create/list, connect_messages_send/list/ack, connect_runs_submit/list/get/wait/claim/heartbeat/complete/fail/cancel/rework, connect_questions_ask/answer, connect_events_list. Admin create/update/revoke/reset not exposed as model tools. Each tool delegates exact RPC method; auth in env/file, never accepts token parameter.

CLI: bin/connect.mjs serve [--port N] [--state-dir PATH]; status; rpc METHOD [--params-file PATH|-] [--token-file PATH] [--url URL]; mcp; install [--apply] [--target codex|claude|other --target-dir PATH]; legacy ... forwards original 0.1.1 CLI unchanged. Default state ~/.unagent/connect; port18492; no automatic LaunchAgent install or old-service shutdown.
