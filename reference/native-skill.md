
# 跨会话协作

【何时使用】用户的目标适合拆给多个已共享的 AI 会话并行处理，或需要把工作交给另一个协作会话继续完成，或按需读取用户引用对话的可见消息时。

## 标准流程

1. 先用 sessions_list 查看**已共享**的会话，以及当前可选的模型和子代理目录。选已有会话时，使用返回的精确 sessionId。
2. 没有合适的会话时，先从目录中选现有 modelId / agentId，再用 sessions_create 建一个空的共享会话。不要猜模型或子代理 ID，也不要把整段历史复制过去。
3. 用户明确要求模型执行工作时，用 sessions_send 的 kind=task 派发；为这项逻辑任务生成稳定的 idempotencyKey，重试同一派发时必须复用原键。返回的任务回执只代表已接收，不代表完成。
4. 独立任务可以连续派发；之后一次用 tasks_wait 等待多个 taskId。等待中的任务由 runner 暂停并自动接续，**不要循环调用 tasks_get 轮询**。再用 tasks_get 只检查某个任务的当前状态或结果。
5. 若等待结果显示子任务处于 waiting_origin 并带有 questionId，按该任务的原问题作答，用 tasks_answer 同时提交 taskId、questionId 和 answer，然后再等该任务。不要把答案发成新任务。
6. 等所有相关任务结束后，再整合结果；明确区分完成、失败、取消和仍在等待的部分。

## 消息与任务的区别

- kind=message 只把普通消息追加到目标会话并返回回执，**不会启动 AI**。
- kind=task 才会创建可跟踪的任务并启动协作执行。派发成功不是任务完成的证明。

## 安全和预算

- 只通过 sessions_list 发现共享会话；目标 sessionId 是工具参数，调用者来源的 sessionId / taskId 由运行时绑定，绝不尝试在参数里指定 actor、origin、父任务或来源 ID。
- 只发送完成子任务所需的背景、目标和交付格式。不要转发全部历史、密钥、无关笔记或用户的整份上下文。
- 每个根任务最多 12 个后代、深度最多 4 层；优先少量、边界清楚的并行任务，避免无意义拆分。
- waiting_user 是留给用户本人的决定，只能由本地界面处理。不能用 tasks_answer 冒充用户审批；协作也不能跳过工具原有的用户确认。
- 内部子代理澄清时，必须回答实际返回的 questionId；不能仅凭旧问题文本猜测或复用过期 questionId。
- 任务状态使用安全任务快照；引用正文按需用 sessions_read 读取可见消息，不暴露私有字段；协作结果不会自动让任务之间互相发消息，是否继续派发由当前任务按用户目标判断。

## 外部 AI 参与者

当本轮提供 participants_list / participants_send 时，用它们发现和联系外部参与者；只使用返回的 ID。未提供这些工具时，不宣称可联系外部 AI。

## 共同协作规则

- 先发现真实参与者，再使用返回的精确 ID；不猜名称、在线状态或能力。
- 把任务目标、输入、交付物和完成条件说清楚。回执只是接收，完成必须有结果。
- 同一操作重试复用稳定幂等键；断线后先查询，不盲目重放领取、完成、失败等修改。
- 澄清问题使用真实 questionId；用户审批只能由用户处理，不可代答或绕过。
- 仅传任务必要内容，不传凭据、无关历史或无关笔记。没有数据就说明没有数据。

## 引用对话与按需读取

- @对话引用只提供目标 sessionId、标题等元信息，不包含消息正文，也不会启动目标 AI。引用本身不是派活指令。
- 用户只要求了解、总结、比较或读取引用对话时，内置用 sessions_read，外部 CLI 用 call sessions.read；按需读取接口返回的可见 user/assistant 消息。需要更早消息且返回 nextCursor 时，把它原样作为下一次 cursor；已足够回答时停止，不猜游标、不批量转发整段历史。
- 仅用户明确要求派活时，才用 sessions_send / participants_send（外部为 sessions.send / participants.send）派发任务；读取引用不发送消息、不创建任务、不唤醒目标。
- 只消费 reader 返回的安全消息投影，不请求、重建或暴露私有字段，例如隐藏推理、系统提示、工具原始参数/结果、运行检查点、执行凭证或认证信息；读取仍服从当前调用者可见范围和权限。

## 文件产物回传

Codex/Claude 若需要返回文件清单，可在最终回复使用完整 JSON 对象 {"text":"简短结果","artifacts":["项目内相对路径"]}。Hub 会实际检查文件存在及路径范围。普通文字回复也有效；没有创建文件时不要编造产物路径。


## 外部入口名称与用途

引导用户为外部 AI 配对时填写便于识别的名称和简短用途，例如名称“Codex 工作”、用途“代码检查”。CLI 使用 client-register --name NAME，可选 --purpose PURPOSE；不要替用户编造用途。展示和选择入口时结合后端返回的真实名称、用途识别目标，不把用途当身份或授权。

## 独立通讯中心 Hub

当工具表中有 hub_connect 且当前设备已连接 Hub 时，可使用独立通讯中心联系外部 Agent。先用 action=connect_participants_list、params={} 获取获准入口，随后选择返回的精确 recipientId。

- 参考内部对话用 sessions_read；内部会话派活用 sessions_send。
- 向 Hub 外部入口派活：hub_connect action=connect_runs_submit，params={recipientId,content,idempotencyKey}。发送普通消息使用 connect_messages_send 的同名参数，不会启动模型。
- 保存返回的任务 id，调用 connect_runs_wait，params={runId}。等待在程序内进行并让出执行名额；不要用模型循环查询。
- 子任务提出工作澄清时，用 connect_questions_answer，params={questionId,answer:文字}，然后继续等待原任务。用户批准只能在接收方原生界面或本机管理页处理。
- 取消用 connect_runs_cancel，params={runId}；查询用 connect_runs_get。不要提供 actor、parentRunId、executionToken、凭据或其他来源字段，这些由宿主注入。
- 收到回执不表示执行完成。遇到断线、不确定或中断，保存原编号检查，不换编号重新派发。
