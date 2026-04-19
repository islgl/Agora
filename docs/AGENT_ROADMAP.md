# Agora Agent Roadmap

从"带工具的 chatbot"进化为生产级 agent 的分阶段规划。参考系:Claude Code、OpenCode。
不追求一次做完 —— 每个 phase 都有明确 DoD,交付后回来复盘再起下一步。

> **当前进度** · Phase A / B / C / D / E 全部骨架完成,待一次整体真机联调。
> 参考文档:[`TOOLS.md`](./TOOLS.md)。

## 总原则

1. **每阶段独立可用**。不做"下半年才能看到价值"的铺垫性重构。
2. **现有能力先复用,再扩展**。MCP / Skills / 多步工具循环 / web search 已在,不推倒。
3. **Rust 作为安全边界**。所有会动文件、执行进程的工具都在 Rust 侧,前端只发意图。
4. **审批优先**。危险动作默认需要用户确认,而不是事后回滚。
5. **Agent 语义诚实**。不展示模型没真做过的"规划"或"状态",UI 反映真实行为。

## 已有基线

| 能力 | 状态 |
|---|---|
| 多 provider(OpenAI / Anthropic / Gemini)+ 代理 fetch | ✅ |
| MCP server 接入(`list_frontend_tools` / `invoke_tool`) | ✅ |
| Skills 系统 | ✅ |
| 多步工具循环(`stepCountIs(20)`) | ✅ |
| Web search(原生 + Tavily 兜底) | ✅ |
| Extended thinking | ✅ |
| 对话历史、分支、导出 | ✅ |
| Plan UI 原型(`agent-plan.tsx`) | ⚠️ 现为 stream trace 推导,Phase B 会接正经数据源 |

---

## Phase A — 工具栈 + 审批系统

**目标**:没 FS/Bash 不叫 agent。这一阶段做完,模型能在本机读写文件、跑命令,并且有安全闸门。

### 范围

1. **内建工具(Rust 实现,走 `invoke_tool` 通路)**
   - `read_file(path, offset?, limit?)`
   - `write_file(path, content)` — 需审批
   - `edit_file(path, old_string, new_string, replace_all?)` — 需审批
   - `glob(pattern, path?)`
   - `grep(pattern, path?, glob?, type?, output_mode?)`
   - `bash(command, timeout_ms?, cwd?)` — 需审批
   - `bash_background(command, cwd?)` → 返回 task_id
   - `read_task_output(task_id)` / `stop_task(task_id)`

2. **审批系统**
   - 每个写/执行工具被调用时,前端弹对话框:**Allow once / Allow for session / Always allow / Deny**
   - allowlist 支持模式匹配(如 `bash(git *)` 自动通过、`write_file(/etc/**)` 自动拒绝)
   - Session-level 状态保存在内存,Always 写入 SQLite `permissions` 表
   - Settings 里可编辑已保存的 permissions

3. **工作目录约束**
   - 可选"工作区根目录"(Settings),FS 工具默认 scope 到该目录
   - 超出时要审批,或直接 deny(看 Settings 偏好)

4. **UI**
   - `ToolCallBlock` / Plan UI 显示审批状态(pending approval / approved / denied)
   - 新 `PermissionsForm` 在 Settings 里

### DoD

- [ ] 用户装上后能让模型读项目代码并改一个文件(体验跟 Claude Code 类似)
- [ ] `bash` 调用首次弹审批,选 "Always" 后同 session 不再问
- [ ] `write_file` 到工作区外会 deny 或额外审批
- [ ] 审批日志可审计(SQLite 表)
- [ ] 文档 `docs/TOOLS.md` 描述每个内建工具的签名和权限模型

### 预估

1-2 周。Bash 工具 + 审批系统是大头,FS 工具相对模板化。

---

## Phase B — TodoWrite + Plan UI 升级

**前置**:Phase A(需要有真实工具活动,todo 才有实际内容)。

**目标**:Plan UI 不再从 stream 事件推导,而是模型通过 `TodoWrite` 工具主动管理的任务清单。

### 范围

1. **`TodoWrite` 工具**
   - 输入:`{action: 'set', todos: Todo[]}` 或 `{action: 'update', id, ...}`
   - 模型按步骤维护自己的 todo:规划阶段输出完整列表,执行阶段逐个标完成
   - 存储在会话级 state(conversation metadata)

2. **`TodoGet` / `TodoList` 工具**
   - 模型能查自己当前的 todo 状态(恢复上下文时有用)

3. **Plan UI 重接**
   - Data source:`useChatStore().todos[conversationId]`
   - 不再从 `MessagePart` 推导
   - 每个 todo 支持 pending / in_progress / completed / blocked 四态
   - 用户可手动插入、删除、重排序(发给模型一条 user message "我插了个 todo X")

4. **System prompt 集成**
   - 会话级 system 告诉模型"复杂任务先用 TodoWrite 规划,然后一个一个做,做完即时 update"

5. **清理**
   - 删除 `AssistantPlan.tsx` 从 parts 推导的逻辑(或降级为 fallback)
   - 删除 `step_start` MessagePart(如果完全不用了)

### DoD

- [ ] 给模型一个复杂任务("重构 X 模块,分成若干步"),它自动产出 todo 列表渲染在 Plan UI
- [ ] 执行中 todo 状态实时更新(pending → in_progress → completed)
- [ ] 用户能手动改 todo 并让模型知道

### 预估

3-5 天。

---

## Phase C — 规划 / 执行模式

**前置**:Phase A + B。

**目标**:像 Claude Code 的 Plan Mode —— 用户可以让 agent 先只做只读调研 + 出方案,等批准后再执行写操作。

### 范围

1. **模式 state**
   - Conversation-level `mode: 'chat' | 'plan' | 'execute'`
   - Plan 模式下工具集自动限制为只读(`read_file` / `glob` / `grep` / web search),写工具不挂载
   - UI 显示当前模式(顶部 chip)

2. **模式切换**
   - 用户侧:输入框附近的模式切换器,或 `/plan` / `/execute` slash command
   - 模型侧:`EnterPlanMode` / `ExitPlanMode` 工具,模型可主动提议进入 plan 模式
   - Plan 模式产出 → 渲染"批准此计划"按钮 → 点击后自动切 Execute 模式并 resume

3. **Execute 模式的 autonomy**
   - 写工具不再每次弹审批(按 Phase A 的 allowlist 走)
   - 但"unauthorized destructive"(如 `rm -rf`、`git push --force`)仍弹

4. **与 TodoWrite 协同**
   - Plan 模式产出的方案通常就是一串 todo
   - Execute 开始时自动把 todo 状态从 pending 推进

### DoD

- [ ] 用户发"帮我评估怎么重构 X",agent 自动入 Plan 模式,只读,产 plan
- [ ] 用户点批准,Execute 开始,按 todo 跑
- [ ] UI 清晰显示当前模式

### 预估

1 周。

---

## Phase D — 子 agent + 后台执行

**前置**:Phase A + B + C。

**目标**:主 agent 能分派子任务给 sub-agent,让长任务不阻塞主流程,复杂 context 不污染主窗口。

### 范围

1. **`Task` 工具(子 agent)**
   - 输入:`{description, prompt, subagent_type?, model?, background?}`
   - 后端启一个独立 `streamText` session,共享全局 settings 但独立 context
   - 默认前台运行 → 结果作为 tool result 返回主 agent
   - `background: true` → 立即返回 task_id,主 agent 继续跑,结果通过通知或 `read_task_output` 查询

2. **子 agent 类型**
   - MVP:`general-purpose`(默认)
   - 预留接口:后续支持自定义 agent 配置文件(类似 Claude Code 的 `.claude/agents/*.md`)
   - 每种类型绑定不同 system prompt + 工具白名单

3. **UI**
   - 子 agent 运行时在 `ToolCallBlock` 里显示小型 trace(折叠的 Plan 视图)
   - 后台 task 在侧边栏有一个"Running"徽章,点击看详情
   - 通知 / toast 在完成或失败时弹

4. **资源隔离**
   - 每个子 agent 有独立 token 预算上限(Settings 配)
   - 超限自动 stop,返回已产出内容

### DoD

- [ ] 主 agent 能用 `Task` 分派"搜遍全仓 X 相关代码"的调研任务,子 agent 在隔离 context 干完返回 summary
- [ ] 后台 task 能关窗继续跑(macOS agent 模式)
- [ ] 子 agent 崩溃 / 超时不影响主 agent

### 预估

1-2 周。

---

## Phase E — Context 管理 + 持久化 + Hooks

**前置**:Phase A + B + C + D。

**目标**:长会话不爆 context,跨重启能恢复,用户有扩展点。

### 范围

1. **上下文溢出提示**(原 compaction 已移除)
   - desktop 场景极少触发上下文上限,前端不再做自动压缩
   - provider 返回 context-length-exceeded 类错误时,assistant 气泡显示
     "Context window exceeded for this model. Start a new conversation to continue."
     而非原始错误文本

2. **AGENT.md / memory 加载**
   - 启动会话时自动加载 `./AGENT.md` 或用户 `~/.agora/memory/` 内容,注入 system
   - UI 里显示当前 context 来源("loaded from: ./AGENT.md")

3. **任务级持久化**
   - 当前对话已持久化,但正在跑的 task / subagent / background 命令会在重启时丢失
   - 新:`sessions` 表存活跃 task 状态,重启时询问用户是否 resume

4. **Hooks 系统**
   - Settings 里配 JSON:
     ```json
     {
       "hooks": {
         "postToolUse": [
           { "matcher": "bash", "command": "echo '$TOOL_INPUT' >> ~/.agora/audit.log" }
         ]
       }
     }
     ```
   - 事件:`preToolUse` / `postToolUse` / `sessionStart` / `sessionEnd` / `userPromptSubmit`
   - 钩子失败策略:block / warn / ignore 可配

### DoD

- [ ] 500 条消息的对话不因 context 限制罢工
- [ ] 项目里有 AGENT.md,agent 打开会话自动遵循
- [ ] 重启后后台 task 能恢复(或明确提示用户该 task 已死)
- [ ] 用户写一个 hook 把所有 bash 调用写到审计日志里,跑通

### 预估

2 周+。

---

## 路线图之外(暂不排期,留作参考)

- 多窗口 / 多 session 并行(类似 Claude Code 的 `--continue` / `--resume`)
- 远程 agent(任务跑在服务器,本地只看结果)
- 团队共享 skill / memory(sync 到 git)
- 可视化 agent 工作流编排(拖拽式)
- 成本追踪 + 月度账单视图

---

## 当前位置

`phase == "E · done(待联调)"`。A/B/C/D/E 骨架全落地、41 个 Rust 单测 + TS 类型检查通过。
- A:工具栈 + 审批系统
- B:TodoWrite + Plan UI(store 驱动,老 AssistantPlan 仍作 fallback)
- C:`chat` / `plan` / `execute` 三态,模式对工具集起 filter + Execute 自动 session-allow write/edit,mode chip / `/plan` / `/execute` slash / `enter_plan_mode` / `exit_plan_mode` 代理侧工具齐全
- D:`task` / `read_subagent_output` / `stop_subagent` 三件套,前端独立 streamText session + step cap 10,subagent 仅拿 readonly 工具集(无 recursion),`SubagentsIndicator` 徽章展示运行中任务
- E:`AGENT.md` 自动加载 + 状态 chip、上下文溢出时提示用户新建对话(原 auto compaction 已下线)、hooks 系统(preToolUse/postToolUse + block/warn/ignore 三档 fail mode,`$TOOL_NAME/$TOOL_INPUT/$TOOL_OUTPUT` env);任务级持久化仅做 graceful degradation(stale task_id 返 clean error),真正 resume 留给 E+

下一动作:整体真机联调 —— 从 AGENT.md 遵循、hooks 审计日志,到 Phase A 的审批、B 的 TodoWrite、C 的模式切换、D 的 task 调度全部串一遍。之后 commit 进 main。
