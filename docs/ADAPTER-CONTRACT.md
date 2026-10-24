# Adapter contract 0.2

All driver sources use ES modules .mjs. Do not edit shared core or other adapters without owner agreement.

export `createAdapter(options = {})` returning `{id,capabilities,health(config),execute(ctx),cancel(ctx),recover?(ctx)}`. Adapter id: codex | claude | workbuddy | harness | unagent.

`ctx` is `{run, participant, signal, emit, saveBinding, ask, mcpConfig}`.

run: `{id,threadId,workspace,content,round,attemptId,nativeSessionId?,nativeBinding?,answer?,deadlineAt}`. participant `{id,name,provider,workspace,autoExecute,config}`; config contains explicit adapter-local launch/binding options, never arbitrary shell snippets.

`execute` resolves `{text,artifacts?:string[],nativeSessionId?,nativeBinding?}` only on confirmed success. Throw on explicit failure; after uncertain admission throw error with `code='OUTCOME_UNKNOWN'` to retain execution locks. No retries of unknown native execution. `recover` may query persisted native IDs, never resubmit.

`ctx.saveBinding({nativeSessionId?,nativeBinding?})` persists identifiers before continuing. `ctx.emit({type,text?,data?})` reports bounded visible progress (not tokens/hidden reasoning). `ctx.ask({kind:'clarification'|'approval',text,options?,nativeRequestId?})` returns `{answer?,approved?:boolean}` only when authorized responder answers. It marks run waiting and releases global capacity, but retains thread/project reservation. Approval is admin-only, cannot be answered by another agent. Cancel must abort any outstanding question.

`ctx.mcpConfig` is a stdio MCP entry `{command,args,env}` bound to recipient participant, current attempt, and project; drivers can attach under name unagent-connect in native SDK/App Server config, no global config writes. Propagate native project tools/skills; do not switch provider or steal credential files.

`cancel(ctx)` resolves `{stopped:true}` only after matching terminal native evidence; otherwise `{stopped:false}`. Do not kill unrelated sessions. Binding to explicit existing session requires idle and matching project validation. Default dedicated session per participant/project (binding persists after rework).

Health: `{state:'available'|'needs_setup'|'incompatible'|'degraded',version?,message}` no secret values. Capabilities literal booleans `{manualMessaging:true,automaticExecution,sessionResume,cancellation,permissions,contextRead:false,artifacts}`. Health is not successful execution.

Core owns scope validation/auth/task graph/idempotency/lease/scheduling/state persistence. Adapter owns native runtime/protocol. Public API methods in HUB-CONTRACT.md.
