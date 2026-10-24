import { Protocol } from '@modelcontextprotocol/sdk/shared/protocol.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema, InitializeRequestSchema, InitializedNotificationSchema, LATEST_PROTOCOL_VERSION, SUPPORTED_PROTOCOL_VERSIONS } from '@modelcontextprotocol/sdk/types.js'
import { setTimeout as delay } from 'node:timers/promises'

const str = { type: 'string', minLength: 1 }
const strings = { type: 'array', items: str }
const num = { type: 'integer', minimum: 0 }
const anyAnswer = { anyOf: [{ type: 'string' }, { type: 'object', additionalProperties: true }, { type: 'array' }, { type: 'number' }, { type: 'boolean' }, { type: 'null' }] }
const spec = (method, description, properties = {}, required = []) => ({ name: 'connect_' + method.replaceAll('.', '_'), method, description, inputSchema: { type: 'object', properties, required, additionalProperties: false } })
export const TOOL_SPECS = [
  spec('participants.list', '列出当前身份可见的参与者。'),
  spec('threads.create', '与参与者创建会话，重试复用幂等键。', { recipientId: str, title: str, idempotencyKey: str }, ['recipientId', 'idempotencyKey']),
  spec('threads.list', '列出可见会话。'),
  spec('messages.send', '发送普通消息，不会自动启动执行。', { recipientId: str, threadId: str, content: str, idempotencyKey: str }, ['recipientId', 'content', 'idempotencyKey']),
  spec('messages.list', '读取可见会话的消息。', { threadId: str, after: str, limit: { ...num, maximum: 100 } }, ['threadId']),
  spec('messages.ack', '标记消息已读。', { messageId: str }, ['messageId']),
  spec('runs.submit', '派发任务。受管理环境会自动绑定可信父任务；普通消息请用 messages_send。', { recipientId: str, threadId: str, content: str, idempotencyKey: str, dependencyRunIds: strings }, ['recipientId', 'content', 'idempotencyKey']),
  spec('runs.list', '列出可见任务。'),
  spec('runs.get', '查询现有任务，避免超时后重复派发。', { runId: str }, ['runId']),
  spec('runs.wait', '在程序内部等待任务完成、需要输入或到期；无需每 25 秒轮询。', { runId: str }, ['runId']),
  spec('inbox.list', '查看当前参与者待办。'),
  spec('runs.claim', '手动领取任务，使用返回的执行凭证。', { runId: str, idempotencyKey: str }, ['runId', 'idempotencyKey']),
  spec('runs.heartbeat', '为已领取任务续租。', { runId: str, executionToken: str }, ['runId', 'executionToken']),
  spec('runs.complete', '提交已确认完成的结果。', { runId: str, executionToken: str, text: str, artifacts: strings }, ['runId', 'executionToken', 'text']),
  spec('runs.fail', '报告执行失败，不能把未知状态当成功。', { runId: str, executionToken: str, error: anyAnswer }, ['runId', 'executionToken', 'error']),
  spec('runs.cancel', '取消指定任务。', { runId: str }, ['runId']),
  spec('runs.rework', '对已停止任务返工，保留原会话。', { runId: str, content: str, idempotencyKey: str }, ['runId', 'content', 'idempotencyKey']),
  spec('questions.ask', '请求澄清或用户批准；批准必须由本机用户处理。', { runId: str, executionToken: str, kind: { enum: ['clarification', 'approval'] }, text: str, options: strings }, ['runId', 'executionToken', 'kind', 'text']),
  spec('questions.answer', '只回答有权限的工作澄清，不能代答用户审批。', { questionId: str, answer: anyAnswer }, ['questionId', 'answer']),
  spec('events.list', '获取按权限过滤的事件和续接游标。', { after: num, limit: { ...num, maximum: 100 }, runId: str }),
]
const byName = new Map(TOOL_SPECS.map(tool => [tool.name, tool]))
const stopStatuses = new Set(['completed', 'failed', 'cancelled', 'interrupted', 'uncertain', 'paused', 'cancel_requested', 'waiting_question', 'waiting_approval'])

function validate(args, schema) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('工具参数必须是对象')
  for (const key of Object.keys(args)) if (!Object.hasOwn(schema.properties, key)) throw new Error(`不允许工具参数: ${key}`)
  for (const key of schema.required) if (args[key] === undefined) throw new Error(`缺少参数: ${key}`)
  for (const [key, value] of Object.entries(args)) {
    const s = schema.properties[key]
    if (s.type === 'string' && (typeof value !== 'string' || value.length < (s.minLength || 0))) throw new Error(`参数无效: ${key}`)
    if (s.type === 'integer' && (!Number.isSafeInteger(value) || value < s.minimum || (s.maximum !== undefined && value > s.maximum))) throw new Error(`参数无效: ${key}`)
    if (s.type === 'array' && (!Array.isArray(value) || value.some(x => typeof x !== 'string'))) throw new Error(`参数无效: ${key}`)
    if (s.enum && !s.enum.includes(value)) throw new Error(`参数无效: ${key}`)
  }
}
export function managedContext(env = process.env) {
  const parentRunId = env.UNAGENT_CONNECT_RUN_ID, executionToken = env.UNAGENT_CONNECT_EXECUTION_TOKEN
  if (Boolean(parentRunId) !== Boolean(executionToken)) throw new Error('受管理 MCP 必须同时提供任务 ID 和执行凭证')
  return parentRunId ? { parentRunId, executionToken } : {}
}
export function createToolHandler(client, { env = process.env, waitDeadlineMs = 30 * 60000, now = Date.now, pause = delay } = {}) {
  const trusted = managedContext(env)
  return async (name, input = {}, { signal } = {}) => {
    const tool = byName.get(name)
    if (!tool) throw new Error('未知或未开放的工具')
    validate(input, tool.inputSchema)
    // Even malformed direct MCP calls cannot smuggle sender/auth/parent overrides.
    const params = { ...input }
    if (tool.method === 'runs.submit' || tool.method === 'runs.wait') Object.assign(params, trusted)
    if (tool.method === 'questions.answer' && params.answer && typeof params.answer === 'object' && Object.hasOwn(params.answer, 'approved')) throw new Error('用户审批仅允许在本机管理页回答')
    if (tool.method !== 'runs.wait') return await client.call(tool.method, params, { signal })
    const until = now() + waitDeadlineMs
    let last
    do {
      signal?.throwIfAborted()
      const remaining = until - now()
      if (remaining <= 0) return last
      last = await client.call('runs.wait', { ...params, timeoutMs: Math.min(25000, remaining) }, { signal })
      const run = last?.run || last
      if (!run || typeof run.status !== 'string') throw new Error('runs.wait 返回无效任务')
      if (stopStatuses.has(run.status) || run.question) return last
      const deadline = typeof run.deadlineAt === 'number' ? run.deadlineAt : Date.parse(run.deadlineAt)
      if (Number.isFinite(deadline) && deadline <= now()) return last
      // Revision changes can wake the RPC immediately; avoid a busy loop without involving the model.
      await pause(Math.min(100, Math.max(0, until - now())), undefined, { signal })
    } while (now() < until)
    return last
  }
}
// Use SDK Protocol/stdio framing directly: this fixed tool-only server needs no
// arbitrary elicitation JSON-schema compiler (and no AJV data-file payload).
class ToolServer extends Protocol {
  constructor() {
    super({})
    this.setRequestHandler(InitializeRequestSchema, async request => ({
      protocolVersion: SUPPORTED_PROTOCOL_VERSIONS.includes(request.params.protocolVersion) ? request.params.protocolVersion : LATEST_PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: 'unagent-connect', version: '0.2.0' },
    }))
    this.setNotificationHandler(InitializedNotificationSchema, async () => {})
  }
  assertCapabilityForMethod(method) { if (method !== 'ping') throw new Error('不支持服务端请求') }
  assertNotificationCapability(method) { if (!['notifications/cancelled', 'notifications/progress'].includes(method)) throw new Error('不支持该通知') }
  assertRequestHandlerCapability(method) { if (!['initialize', 'ping', 'tools/list', 'tools/call', 'tasks/get', 'tasks/result', 'tasks/list', 'tasks/cancel'].includes(method)) throw new Error('不支持该工具入口') }
  assertTaskCapability() { throw new Error('不支持 MCP 异步任务扩展') }
  assertTaskHandlerCapability() { throw new Error('不支持 MCP 异步任务扩展') }
}
export async function startMcp({ client, env = process.env, transport = new StdioServerTransport() }) {
  const handle = createToolHandler(client, { env })
  const server = new ToolServer()
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOL_SPECS.map(({ method, ...tool }) => tool) }))
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    try {
      const result = await handle(request.params.name, request.params.arguments || {}, { signal: extra.signal })
      return { content: [{ type: 'text', text: JSON.stringify(result) }] }
    } catch (error) {
      return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: { code: error.code || 'TOOL_ERROR', message: error.message } }) }] }
    }
  })
  await server.connect(transport)
  return server
}
