# Agora 整体测试计划

覆盖 Phase A–E 的所有落地能力。按顺序跑,每一节的前置条件建立在上一节之上——除非单独标注"独立",别跳步。

测试用例编号:`<PHASE>-<编号>`(例 `A-3`)。测到问题时报编号即可,我能直接定位。

## 0 · 准备环境

### 0.1 构建与启动

```bash
cd /Users/lgl/code/ai/agora
pnpm install            # 如果依赖过期
pnpm tauri dev          # 启动开发版
```

期望:窗口正常打开,Settings 里至少配了一个 model provider(OpenAI / Anthropic / Gemini 任一)并能通过 test connection;API key 已填。没配模型就一切免谈。

### 0.2 准备一个干净测试仓库

在某处建一个专门用来测的小仓库(不要用 agora 本身——避免真的改到自己):

```bash
mkdir -p ~/tmp/agora-smoke && cd ~/tmp/agora-smoke
git init
mkdir -p src docs
cat > src/app.ts <<'EOF'
export const port = 3000;
export const name = "smoke";

export function greet(who: string) {
  return `hello ${who}`;
}
EOF
cat > src/util.ts <<'EOF'
export function sum(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0);
}
EOF
cat > README.md <<'EOF'
# smoke
Testing Agora.
EOF
echo "*.log" > .gitignore
touch ~/.agora/audit.log  # hooks 测试会往这里写
git add . && git commit -m "init"
```

### 0.3 Settings 初始化

打开 Settings:
1. **General → Workspace root**: 选 `~/tmp/agora-smoke`。Save。
2. **General → Auto-approve read-only tools**: 开着(默认)。
3. **Capabilities → Web search**: 看你喜好;本 plan 不依赖。
4. **Permissions**: 空规则。
5. **Hooks**: 空(`{}`),Save。

---

## A · 工具栈 + 审批系统

### A-1 只读工具免审批(auto-approve readonly ON)

**操作**:新建对话,发:

> "列一下当前 workspace 下所有 .ts 文件,然后 grep 一下 `port` 出现在哪里,最后 read 一下 src/app.ts。"

**期望**:
- 模型调 `glob` → 列出 `src/app.ts` / `src/util.ts` 两个文件
- 调 `grep "port"` → 命中 `src/app.ts:1`
- 调 `read_file src/app.ts` → 返回带行号的内容
- 三次调用全都**无审批弹窗**
- 聊天最终给出总结

### A-2 只读审批打开的对照

**操作**:Settings → General → 关掉"Auto-approve read-only tools",Save。新对话发 "read src/util.ts"。

**期望**:
- 弹出审批卡片,标的是 `read_file`,有 Once / This session / Always / Deny
- 点 **Once** → 工具执行,返回内容;规则**未**持久化(刷新 Permissions tab 没新条)
- **测完恢复** Auto-approve readonly 为 ON(后续用例默认都依赖它)

### A-3 write_file 审批 Once

新对话发:

> "在 workspace 里写个新文件 `src/hello.ts`,内容 `export const hi = 1;`。"

**期望**:
- 模型调 `write_file`,弹审批卡,显示 path + content 预览
- 点 **Once**,文件写入磁盘(`ls ~/tmp/agora-smoke/src/` 可以看到)
- Permissions tab 仍然是空的

### A-4 write_file 审批 Always + 后续免审批

新对话发:

> "在 `src/` 下再建个 `a.ts`,写 `export const a = 1;`"

- 审批卡出现,这次选 **Always**
- Settings → Permissions 应该多一条 `allow write_file <pattern>`(pattern 取决于 `defaultPatternFor`——通常是具体路径或 `src/**` 之类)

跟着发:

> "再写一个 `src/b.ts`,`export const b = 2;`"

**期望**:
- 如果刚保存的 pattern 覆盖了 `src/b.ts` → 免审批直接写
- 如果只覆盖了具体文件名 → 再弹一次审批(符合预期,pattern 是 defaultPatternFor 决定的)。可以手动在 Permissions 里加一条 `allow write_file src/**` 看下一用例

### A-5 Deny 规则胜过 Allow

**操作**:Settings → Permissions,手动加两条:
- `allow write_file **/*`(广覆盖)
- `deny write_file **/.env`(针对 .env)

新对话发:"在 workspace 根写一个 `.env` 文件,内容 `SECRET=x`"。

**期望**:
- 模型调 `write_file`,立刻被 **Blocked by policy** deny,没弹审批卡
- 磁盘上没有 `.env` 生成
- 模型看到 tool 返回 error 后会解释原因,不会重试

**清场**:测完删除这两条规则(后续用例不依赖)。

### A-6 workspace 外写入必审批

新对话发:"在 `/tmp/agora-outside-x.txt` 写个文件,内容 `outside`"。

**期望**:
- 审批卡弹出来,reason 里提到 "outside the workspace root"
- **点 Deny**(我们不真的写),模型收到 user denied 并放弃

### A-7 edit_file 正常 + 唯一性校验

新对话发:

> "把 src/app.ts 里的 `const port = 3000` 改成 `const port = 4000`"

**期望**:审批通过(Always 或 Once 都行),文件被改,`cat src/app.ts` 能看到新 port。

跟着发:

> "把 src/app.ts 里的 `export` 改成 `export default`"

**期望**:`old_string` 不唯一 → edit_file 报错,模型会解释要么先 read 定位要么用 replace_all。这是预期行为,不算 bug。

### A-8 bash 审批 + `git *` pattern

新对话发:"跑一下 `git status`"。

- 审批卡弹出,**Always**。Permissions 应该新增 `allow bash git *`(或具体命令,取决于 defaultPatternFor——我们的实现取的是"第一个 token + *")
- 再发 "跑 `git log --oneline -n 3`" → 免审批
- 再发 "跑 `ls /tmp`" → 再弹审批(不是 `git *` 命中)

### A-9 bash 交互命令的保护

发:"跑 `vim`"。

**期望**:模型看到 system prompt 里有"不要跑交互命令"的警告,**应该拒绝** / 改口建议其他方式。如果模型还是硬跑了,就 deny 掉;确认我们不会挂住主进程。

### A-10 bash_background + read_task_output + stop_task

发:"后台启动 `sleep 30 && echo done`,给我 task_id"。

- 审批,Once。返回 task_id
- 等 5 秒,发 "查 task_id=<上一个> 的输出" → `read_task_output` 应该报 status=running,output 空
- 发 "stop 一下 task_id=<上一个>" → 审批,Once,报 stopped
- 再发 "查 task_id=<上一个>" → status=killed

---

## B · TodoWrite + Plan UI

### B-1 复杂任务触发 todo_write

**操作**:模式切到 **chat**(后面 C 章再玩 plan)。Clear 所有 running subagents(如果有)。发:

> "帮我给 src/util.ts 加一个 `product` 函数、一个 `mean` 函数,并在 README.md 里记录一下用法。一步一步来。"

**期望**:
- 聊天框顶端出现 `ConversationTodos` 面板(一个小方块),列 3–5 条 todo,初始都 pending 或第一条 in_progress
- 模型开始执行的时候 todo 会随调用 `todo_write` 更新(第一条 in_progress → completed,第二条开始)
- 最多 1 条 in_progress(system prompt 要求的)

### B-2 Todos 跨重启持久化

完成 B-1 的任务后,关掉 `pnpm tauri dev`,重开。打开同一对话。

**期望**:`ConversationTodos` 还在,状态和关掉前一致。可以通过 SQLite 直接看验证:

```bash
sqlite3 ~/.agora/agora.db "SELECT conversation_id, todos_json FROM conversation_todos;"
```

### B-3 简单任务不触发 todo_write

新对话发:"今天周几?"

**期望**:模型直接回答,不会调 `todo_write`。`ConversationTodos` 不出现。

---

## C · Plan / Execute 模式

### C-1 Mode chip 显示 + 切换

在输入框旁边的下拉 chip 应该能看到 **Chat / Plan / Execute** 三选一,当前选中的有 active 标记。点别的选项会立刻切换,chip 颜色变(plan 蓝、execute 琥珀)。

### C-2 Slash command 切模式

输入框里打 `/plan` 回车 → chip 切到 Plan,**不发送**任何消息给模型(toast 提示"Mode → plan")。
接着打 `/execute` 回车 → chip 切到 Execute,toast "Mode → execute"。
打 `/chat` 回车 → 回到 Chat。

### C-3 Plan 模式真的砍了写工具

切到 Plan 模式,新对话发:

> "在 src/ 新建一个 `src/c-plan.ts`,内容随意。"

**期望**:
- 模型尝试工具调用时**压根看不到** `write_file` / `edit_file` / `bash` / `bash_background` / `stop_task`——它应当意识到工具不存在,转而告诉用户"当前在 plan 模式,只能读"
- 如果它硬要,就会报 "tool not found"
- 用 `glob` / `grep` / `read_file` 仍可

### C-4 enter_plan_mode / exit_plan_mode 自主调用

回到 Chat 模式,新对话发:

> "帮我评估一下怎么把 src/app.ts 拆成 server/client 两部分,给个方案。"

**期望**:
- 模型 "应该" 主动调 `enter_plan_mode`(不是 100% 稳定,看模型配合度)
- chip 切到 Plan
- 模型用 `read_file` / `grep` 调研后给出方案 + 可能用 `todo_write` 列步骤
- 结束时调 `exit_plan_mode` → chip 切到 Execute

**如果模型没主动切**:手动 `/plan` 试,至少验证 C-3 那路能跑通。

### C-5 Execute 模式 session-allow write/edit

刚进 Execute 模式(C-4 末尾或手动 `/execute`)。发:

> "执行刚才的计划:在 src/ 新建 `server.ts` 和 `client.ts`,内容随便写点占位。"

**期望**:
- `write_file` 不弹审批(因为 session 里自动加了 `allow write_file('')`)
- `bash` 如果被用到,**仍然弹审批**(这是我们刻意的)

**验证**:开一下 Permissions store(devtools 里跑 `window.__PERMISSIONS__ ??= require('@/store/permissionsStore')` 之类不便 —— 或直接看行为:

- 同 session 新对话,切 Execute,发 "写 src/d.ts" → 免审批
- 同 session 新对话,**切回 Chat**,发 "写 src/e.ts" → 之前 session-allow 对 Chat 模式也是生效的(sessionAllows 是全局 session 级别,不区分对话)。这是符合当前实现的,不算 bug。

---

## D · 子 agent

### D-1 foreground task

新对话、Chat 模式。发:

> "用 task 工具,让一个 subagent 搜遍 src/ 找所有 export 的 symbol,回来给我一个按文件分组的清单。"

**期望**:
- 模型调 `task`,description 短标签 + prompt 内联整个任务
- 输入框上方出现 **1 subagent running** 徽章,Loader2 旋转
- subagent 用 readonly 工具(grep / read_file)工作
- 完成后徽章变 CheckCircle2,点开能看到 description / duration / 一段 outputPreview
- 父 agent 收到 report,输出总结给用户

### D-2 background task

新对话发:

> "后台起一个 subagent(background=true),让它给我把 src/util.ts 每行解释一遍,然后继续跟我聊天。"

**期望**:
- `task` 工具返回 task_id(模型的 assistant 消息里会提到)
- 徽章显示运行中,父 agent **立刻**继续交互
- 过一会儿发 "查一下刚才那个 task_id" → 模型调 `read_subagent_output`,返回状态(running / completed)+ 部分输出

### D-3 stop subagent

D-2 运行时,面板里对它点 X 按钮(或让模型调 `stop_subagent`)→ 状态变 cancelled,Loader2 停,可展开看残留 outputPreview。

### D-4 subagent 没有递归

发:"让 subagent 再开一个 subagent。"

**期望**:subagent 的 toolset 里**没有** `task` 工具(被 `SUBAGENT_BLOCKLIST` 砍了),所以它不会递归。行为表现:父 agent 里的 subagent 报告会说"tool not available"或类似意思。

### D-5 stale task_id 不崩

关 app、重启、同一对话发 "查 task_id=<之前某个 subagent 的 id,或者随便瞎编一个>"。

**期望**:`read_subagent_output` 返回 `unknown task_id <id>`(因为 subagent 只活在 webview 内存里,重启就没了),模型解释并不会崩。

### D-6 list_subagents 枚举

跑完 D-1(foreground completed) 和 D-2(background running) 后,**不要**重启 app。新一轮发:

> "把本 session 里跑过的 subagent 都列一下。"

**期望**:
- 模型调 `list_subagents`(不带参数),返回一行 completed + 一行 running
- 继续 "只看还在跑的" → 模型调 `list_subagents` 传 `{status: "running"}`,只返回 D-2 那条
- 发一个带错误状态的过滤,如 "跑一下 `list_subagents status=bogus`" → tool 报 `invalid status filter \`bogus\``(模型会解释)
- 模型拿到 id 后,应能直接接 `read_subagent_output` / `stop_subagent` 而不需要用户提供 id

**清场**:D-2 那个 background subagent 可以用 `stop_subagent` 或直接关了它,跑完再进 E。

---

## E · Context + memory + hooks

### E-1 AGENT.md 加载

```bash
cat > ~/tmp/agora-smoke/AGENT.md <<'EOF'
# Agora smoke AGENT rules

- 任何编码相关回答里,**必须**在末尾加一行 `-- from AGENT.md rule`。
- 代码里默认用 4 空格缩进。
EOF
```

回到 app,ChatArea 上方应该立刻出现 **AGENT.md · agora-smoke/AGENT.md** 小徽章(因为 App 监听了 `globalSettings.workspaceRoot` 的变化,但 AGENT.md 本身是点一下 chip 或切 workspace 触发 refresh——如果没立刻出,切出 workspace 再切回或点 chip 一下重载)。

新对话发:"给我写一个 TypeScript 函数 `square(x: number)`。"

**期望**:
- 回答最后有 `-- from AGENT.md rule`
- 代码用 4 空格缩进
- 说明 system prompt 里真的带上了 AGENT.md 内容

### E-2 AGENT.md 更新后重载

改 AGENT.md:把规则改成"末尾加 `-- v2`"。点 chip 一下(触发 refresh)→ 发新问题,末尾应该是 `-- v2`。

### E-3 AGENT.md 过大截断

```bash
python3 -c 'print("x"*200000)' > ~/tmp/agora-smoke/AGENT.md
```

点 chip 重载。**期望**:chip 图标变 AlertTriangle(琥珀色),title 写 "truncated"。模型行为不管了——大内容本身就是异常,关键是 UI 有提示 + 不崩。

**清场**:恢复正常 AGENT.md(E-1 那版或删掉)。

### E-4 上下文溢出提示

前端不再做自动压缩。模型 provider 返回 context-length-exceeded 类错误时,应替换成友好提示而不是原始错误。

模拟方式:临时把 `src/hooks/useAiSdkChat.ts` 里 `OVERFLOW_PATTERNS` 其中一条改成 `/./i` 让任何错误都命中(测后复原);或把模型 baseUrl 改成一个会返回 400 的假网关。

**期望**:assistant 气泡最后显示:
> ⚠ Context window exceeded for this model. Start a new conversation to continue.

普通错误路径不受影响(仍显示 `Error: <provider msg>`)。

### E-6 Hooks — postToolUse 审计 bash

Settings → Hooks,粘贴:

```json
{
  "postToolUse": [
    {
      "matcher": "bash",
      "command": "echo \"$(date -u +%FT%TZ) $TOOL_NAME input=$TOOL_INPUT exit=$TOOL_OUTPUT\" >> ~/.agora/audit.log",
      "failMode": "warn"
    }
  ]
}
```

Save。新对话发 "跑一下 `git status`" → 审批过掉。

**期望**:

```bash
tail -1 ~/.agora/audit.log
```

应该有一行刚刚的记录,包含 `bash`、`git status` 入参、以及 exit code。

### E-7 Hooks — preToolUse block

改 Hooks 成:

```json
{
  "preToolUse": [
    {
      "matcher": "write_file",
      "command": "if echo \"$TOOL_INPUT\" | grep -q '\\.env'; then echo 'refusing to write .env' >&2; exit 1; fi",
      "failMode": "block"
    }
  ]
}
```

Save。新对话发 "在 workspace 写 `.env`,内容 `FOO=1`"。

**期望**:
- 即使 Permissions 里允许 write_file,hook 也会**在写之前**拦住
- 模型收到 `Blocked by preToolUse hook (matcher: write_file, exit 1)\nrefusing to write .env` 作为 tool error
- 磁盘上没有 .env

写个普通文件 `src/ok.ts` → hook 不拦(hook 命令 grep 只匹配 `.env`)→ 正常写入。

### E-8 Hooks 脚本超时

```json
{
  "preToolUse": [
    { "matcher": "bash", "command": "sleep 30", "failMode": "block" }
  ]
}
```

发 "跑 `ls /tmp`"。

**期望**:15 秒后,tool 返回 `Blocked by preToolUse hook ... hook timed out after 15s`,不会挂 app。

**清场**:Hooks 配置清回 `{}`(或只留 E-6 的审计规则)。

### E-9 Hook JSON 非法时不崩

Hooks textarea 里输入 `not valid json`。Save 按钮应该 disabled,下面有红字错误提示。**不要点 save**(点不了),测试 UI 防御即可。清回 `{}` save。

---

## F · 整体串联 / 回归

### F-1 一个真实任务跑全链

新对话,Chat 模式(保证 AGENT.md 已加载、压缩阈值 80)。发:

> "帮我在 src/ 里新建一个 `math.ts` 模块,带 `add / sub / mul / div` 四个函数,每个函数写一个对应的单元测试到 `src/math.test.ts`,最后跑 `npx vitest run` 看是不是过。因为这是改结构的事,先评估再动手。"

**期望**(理想剧本):
1. 模型主动 `enter_plan_mode`,chip 切到 Plan
2. `todo_write` 出 4-6 条 plan
3. 调 `glob` / `read_file` 调研现有代码风格
4. `exit_plan_mode` → Execute
5. session 的 write_file 自动放行(Execute 模式)
6. 挨个 `write_file` 建文件,`todo_write` 逐步 tick
7. `bash "npx vitest run"` → 弹一次审批(bash 在 execute 也要审批)
8. 测试结果回传,模型总结
9. Audit log(E-6 配置若还开着)里多了 `bash` 和 `vitest` 的记录

看 checklist:
- [ ] AGENT.md 规则出现在总结尾巴
- [ ] Plan UI 持续反映 todo 状态
- [ ] 模式 chip 随切换变色
- [ ] 新建的 math.ts / math.test.ts 真实存在

---

## G · 数据 / 状态一致性抽查

任何时候都能跑的健康检查:

```bash
sqlite3 ~/.agora/agora.db <<'SQL'
-- Phase A/B/C: schema 有我们加的列
PRAGMA table_info(conversations);      -- 期望含 mode 列
PRAGMA table_info(global_settings);    -- 期望含 hooks_json

-- Phase A: 权限表
SELECT tool_name, pattern, decision FROM tool_permissions;

-- Phase B: Todos
SELECT conversation_id, substr(todos_json, 1, 120) FROM conversation_todos;
SQL
```

---

## 已知限制 / 非测试范围

以下行为**不是 bug**,而是 MVP 边界:

1. **Subagent 不跨重启恢复** —— 前端 streamText session,关窗就死;stale task_id 返 clean error(D-5)。真正 resume 留给 Phase E+。
2. **Bash background task 关 app 后**也是死的(tokio::process 子进程跟主进程同生命周期)。
3. **Subagent 的 task tool 被剔除** —— 没有递归,设计如此(D-4)。
4. **Session allow 跨对话** —— 一个 session 内多开对话共享 session allow。符合"session 级"的实际语义。
5. **Hooks 只支持 pre/postToolUse** —— sessionStart / sessionEnd / userPromptSubmit 留给 E+。
6. **Hooks 没有 matcher 正则** —— 只支持精确名或 `*`。需要更复杂就写 shell 里判断。
7. **AGENT.md 只读不编辑** —— Settings 里没编辑器,直接文件系统改,chip 点一下重载。

---

## 提 bug 的格式

发现问题时麻烦带:

- 测试用例编号(例 `C-4`)
- 复现步骤
- 期望 vs 实际
- 如果涉及模型输出,贴一段 assistant 消息和/或 tool call JSON
- devtools Console 有没有 warn/error

这样我能直接上手定位。
