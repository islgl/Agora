# Built-in Tools

Agora ships with nine first-class tools the agent can call on every turn.
They run in Rust via the same `invoke_tool` bridge used by MCP servers and
Skill built-ins — the Vercel AI SDK sees a normal `ToolSet`.

Source:
- Tool specs: `src-tauri/src/builtins/mod.rs` (`list_tools`)
- FS impls: `src-tauri/src/builtins/fs.rs`
- Bash impls: `src-tauri/src/builtins/bash.rs`
- Permission gate: `src-tauri/src/commands/permissions.rs`

## Permission model

Every mutating or execution tool (`write_file`, `edit_file`, `bash`,
`bash_background`, `stop_task`) goes through an explicit approval gate before
Rust dispatches the call. Read-only tools (`read_file`, `glob`, `grep`,
`read_task_output`) are auto-approved when **Settings → General →
Auto-approve read-only tools** is on (default).

When a mutating call arrives without a matching allow rule, the chat shows an
inline card with four choices:

| Button | Scope |
|---|---|
| **Once** | Run this call. Save nothing. |
| **This session** | Allow matching calls until the app reloads. |
| **Always** | Persist an allow rule to SQLite (`tool_permissions` table). |
| **Deny** | Cancel the call; the tool result sent back to the model is `User denied this tool call`. |

Deny rules always win over allow rules — a `deny write_file **/.env` rule
blocks `.env` writes even if a broader `allow write_file **/*` rule also
matches.

Paths outside the configured **workspace root** always trigger an approval
prompt, regardless of saved rules. Leave workspace root blank to require
absolute paths for every call.

### Conversation modes (Phase C)

Each conversation carries a `mode` that filters which tools the model even
sees:

| Mode      | Available tools                                                       | Autonomy                                                |
|-----------|------------------------------------------------------------------------|---------------------------------------------------------|
| `chat`    | Everything + `enter_plan_mode`                                         | Writes + bash ask per call unless a saved rule matches. |
| `plan`    | Readonly built-ins + MCP/Skills + `todo_write` + `exit_plan_mode`      | `write_file` / `edit_file` / `bash` / `bash_background` / `stop_task` are **stripped from the toolset** — the model physically cannot call them. |
| `execute` | Everything                                                              | `write_file` and `edit_file` are session-wide allowed the moment the mode flips. `bash` still asks. |

Switch modes via the chip next to the model selector, `/chat` `/plan`
`/execute` slash commands in the input, or by letting the model call
`enter_plan_mode` / `exit_plan_mode` itself. Mode is persisted per
conversation.

### Project memory + hooks (Phase E)

**`AGENT.md`** — if a file named `AGENT.md` exists at the workspace root,
its contents (up to 64 KB) are prepended to every system prompt in that
workspace. A small chip above the input shows when it's loaded; click the
chip to reload from disk. No file = no memory, carries on silently.

**Context overflow** — the app does not try to summarize or truncate
history. If a provider rejects a turn with a context-length-exceeded
error, the assistant bubble shows a plain notice asking the user to
start a new conversation. Desktop chats rarely approach the window in
practice, so the simplest path wins.

**Hooks** — Settings → Hooks takes a JSON blob of pre/post tool-use hooks:

```json
{
  "preToolUse": [
    { "matcher": "bash", "command": "echo $TOOL_INPUT >> ~/.agora/audit.log", "failMode": "warn" }
  ],
  "postToolUse": [
    { "matcher": "*", "command": "..." }
  ]
}
```

- `matcher` — exact tool name or `*`.
- `command` — passed to `/bin/sh -c`. Env vars: `HOOK_EVENT`, `TOOL_NAME`,
  `TOOL_INPUT` (JSON), plus `TOOL_OUTPUT` on post-hooks.
- `failMode` — `block` (only meaningful on `preToolUse`; a non-zero exit
  cancels the tool call), `warn` (logs but continues; default), or
  `ignore`. 15-second per-hook timeout.

### Pattern syntax

Patterns use a minimal glob grammar (from the `globset` crate, with
`literal_separator(false)`):

| Token | Meaning |
|---|---|
| `*` | Any run of characters (including `/` and spaces). |
| `?` | Exactly one character. |
| Anything else | Literal match. |

For `bash` / `bash_background`, the pattern runs against the **command
string**; for everything else, it runs against `path` (falling back to
`cwd`). A good first rule is often:

- `bash` pattern `git *` — auto-approve `git status`, `git log --oneline`, etc.
- `write_file` pattern `src/**` — auto-approve edits inside `src/`.
- `write_file` pattern `**/.env` decision `deny` — never touch `.env` files.

Empty pattern = match any call to that tool. Useful for `read_file` /
`glob` / `grep` when you'd rather rely on the readonly auto-approve toggle.

## Tool reference

### `read_file`

```json
{ "path": "src/app.ts", "offset": 0, "limit": 200 }
```

Returns the file prefixed with `cat -n`-style line numbers. `limit` defaults
to 2000 lines; use `offset` to page through larger files. Relative paths
resolve against the workspace root.

**Default permission:** auto-approved when readonly-auto-approve is on.

### `glob`

```json
{ "pattern": "src/**/*.tsx", "path": "src" }
```

Walks the workspace (or `path`) using the same ignore rules as ripgrep
(`ignore` crate — respects `.gitignore`, `.ignore`, hidden-file skip). Returns
absolute paths, newline-separated.

**Default permission:** readonly — auto-approved.

### `grep`

```json
{
  "pattern": "useAiSdkChat",
  "glob": "**/*.ts",
  "output_mode": "content",
  "head_limit": 100
}
```

Built on `grep-searcher` — the same engine as ripgrep.
`output_mode` is `files_with_matches` (default), `content`, or `count`. The
result caps at `head_limit` lines (default 250) so runaway matches don't
drown the model's context.

**Default permission:** readonly — auto-approved.

### `write_file` — requires approval

```json
{ "path": "src/new-module.ts", "content": "export const x = 1;\n" }
```

Creates parent directories as needed. Refuses inputs larger than 10 MB (the
model should be writing code, not tarballs).

### `edit_file` — requires approval

```json
{
  "path": "src/app.ts",
  "old_string": "const port = 3000",
  "new_string": "const port = 4000",
  "replace_all": false
}
```

`old_string` must occur **exactly once** unless `replace_all` is true. The
file's existing line-ending style (CRLF vs. LF) is preserved.

### `bash` — requires approval

```json
{
  "command": "pnpm test --run",
  "timeout_ms": 120000,
  "cwd": "packages/ui"
}
```

Runs under `/bin/sh -c`. No TTY — interactive programs hang. Returns a JSON
payload `{stdout, stderr, exit_code, timed_out}`. Output truncates at ~512 KB.

### `bash_background` — requires approval

```json
{ "command": "pnpm dev", "cwd": "." }
```

Same shell invocation as `bash`, but returns `{task_id}` immediately. The
child process continues running in the Agora runtime until it exits or you
call `stop_task`.

### `read_task_output`

```json
{ "task_id": "3b5d7c…" }
```

Snapshot of captured stdout + stderr plus `{status: running|exited|killed|failed, exit_code, failure}`.
Read-only; auto-approved when the toggle is on.

### `task` (Phase D · subagent)

```json
{
  "description": "Find all callers of foo",
  "prompt": "Grep src/ for imports of `foo` and summarize what each caller does.",
  "background": false
}
```

Spawns a read-only investigative subagent in an isolated context
(step budget 10). Foreground calls (default) wait and return the report;
`background: true` returns immediately with a `task_id` the model can poll
via `read_subagent_output`. The subagent's toolset is the parent's readonly
slice — no write, edit, bash, or recursive `task`. Runs in the webview, so
closing the window ends it (persistence is Phase E).

### `read_subagent_output`

```json
{ "task_id": "3b5d7c…" }
```

Snapshot of a subagent's current state + accumulated output. Returns the
full text on `completed`, partial text on `running`.

### `stop_subagent`

```json
{ "task_id": "3b5d7c…" }
```

Cancels a running subagent. Partial output is preserved.

### `stop_task` — requires approval

```json
{ "task_id": "3b5d7c…" }
```

Sends SIGTERM; escalates to SIGKILL after 5 s if the child hasn't exited.
Requires approval because a rogue allow rule could unintentionally kill long
builds — the per-task cost of saying "once" is low.

## Writing a useful allow rule

1. **Start narrow, broaden later.** It's easy to widen `git status` to
   `git *` once; it's embarrassing to accidentally allow-list `*`.
2. **Prefer patterns over per-path rules.** A pattern like `src/**`
   stays useful after refactors; `src/commands/foo.ts` rots.
3. **Use deny for the obvious traps.** `deny write_file **/.env`,
   `deny bash rm -rf *`, `deny bash curl * | sh` — cheap insurance.
4. **Remember sessions exist.** For one-off work ("fix this file, then
   we're done"), "This session" is strictly better than "Always".

## Smoke test (manual)

Run these in order against a fresh database to confirm the full loop:

1. `glob`, `grep`, `read_file` auto-complete without an approval prompt.
2. `write_file` on a file inside the workspace → approval card appears.
   Pick **Once** → file appears on disk.
3. `write_file` same path, pick **Always** → rule saves. Call again →
   silent. Different path → prompt reappears.
4. `bash git status` → prompt. Pick **Always** → rule saves as `bash git *`.
   `bash git log --oneline` runs silently. `bash npm install` prompts.
5. `write_file` to a path outside the workspace root → prompts regardless of
   saved rules.
6. Add a **deny** rule for `write_file **/.env`, then an **allow** for
   `write_file **/*`. Writing `.env` is blocked.
7. Settings → Permissions → rules are visible; each row deletes.
