# Roadmap / TODO

Candidate features for Agora, organized by cluster. Each item has a rough
effort estimate (S / M / L) and a short note on what it unlocks.

## 1. Session management ✅ (done)

- [x] Message tree with `parent_id` / `active_leaf_id`
- [x] Edit user message (creates sibling branch)
- [x] Regenerate assistant message (same model)
- [x] Regenerate with a different model
- [x] Sibling navigation `‹ k/N ›`
- [x] Copy message
- [x] Model-name nameplate on assistant replies
- [x] Per-conversation streaming (parallel across conversations)

## 2. Finish MCP / Skill surface

- [ ] **MCP resources** — list + read exposed by servers. Surface as a
      file-browser-ish picker the model can reach via built-in tools, or as
      an `@` mention in the chat input. Effort: M.
- [ ] **MCP prompts** — list + invoke named prompt templates from servers.
      Likely surfaces as slash-commands or a prompt library picker.
      Effort: M.
- [ ] **Pre-shipped example skills** — bundle one or two skills with the
      binary (e.g. "summarize", "translate") so the Skills tab isn't empty
      on first run. Effort: S.
- [ ] **Tool-call authorization prompt** — per-call "approve / reject / always"
      gate instead of running automatically, for MCP tools and skill scripts.
      Effort: M. Touches orchestrator + new event type + modal UI.

## 3. Chat input/output richness

- [ ] **File + image attachments** — multimodal input. Requires:
      - `Message` parts gains an `image` / `file` variant
      - Each provider serializer handles its own multimodal wire format
        (OpenAI `image_url`, Anthropic `image` block with base64, Gemini
        `inlineData`).
      - Drag-and-drop + paste in `ChatInput`.
      - Effort: L.
- [ ] **Thinking / reasoning blocks** — Claude extended-thinking and
      OpenAI o1-style reasoning returned separately from the final
      answer. Backend events exist in the stream; frontend currently
      drops them. Needs a collapsible "Show thinking" block in
      `MessageBubble`. Effort: S–M.
- [ ] **Streaming tool-call input JSON** — `ChatStreamEvent::ToolCallInputDelta`
      is emitted by backend and ignored by `useStreamChat`. Wire it into
      `ToolCallBlock` for a progressive-reveal effect. Effort: S.
- [ ] **Token + cost display** — show prompt/completion tokens and an
      estimated $ next to each assistant reply. Requires per-provider
      usage parsing + a small pricing table. Effort: M.

## 4. Organize + discover ✅ (done)

- [x] **Pin conversations.** `conversations.pinned` column; sort
      `ORDER BY pinned DESC, created_at DESC`. Pin / Unpin in dropdown;
      sidebar renders **Pinned** + **All** as two labeled sections with a
      dashed divider.
- [x] **Auto-generated conversation titles (realtime).** New **General**
      settings tab. `autoTitleMode: 'off' | 'first' | 'every'` (default
      `every`). `title_locked` flips on manual rename — auto-title stops
      overwriting from then on. 10 s debounce per conversation so rapid
      turns coalesce.
- [x] **Export Markdown.** Native save dialog; frontmatter + per-role
      sections, tool calls included as fenced-JSON blocks.
- [x] **Export PDF.** Backend calls `WKWebView.createPDFWithConfiguration`
      and streams bytes straight into the user-picked path — no print
      dialog. PrintOverlay briefly covers the viewport so the capture sees
      the target conversation, not the live chat pane. Preserves the app's
      Tailwind styling 1:1.
- [x] **Batch manage conversations.** Sidebar "selection mode" (sliders
      icon). Per-row styled checkbox. Bulk actions: Pin / Delete.
- [x] **Search message bodies.** SQLite FTS5 virtual table over
      `messages.content` + sync triggers + one-shot backfill. Sidebar search
      debounces 150 ms and queries title LIKE ∪ FTS5 MATCH.
- [x] **Share (macOS native).** `objc2` drives `NSSharingServicePicker`;
      writes the conversation as a temp `.md` and shares the file URL so
      AirDrop / Mail preserve attachment semantics. Menu item hidden on
      non-macOS platforms.

## Explicitly deferred

- **Tavily → MCP migration.** Re-evaluate after MCP resources/prompts lands.
- **Sandboxed skill scripts.** Revisit only if skill script execution is in
  common use (current runtime is timeout + env scrub only).
- **Retry / rate-limit handling.** Add when users actually hit it.
- **Hosted share links.** Needs a server; skip until we have one.
- **Per-conversation dark-mode override for PDF export.** Currently
  `createPDFWithConfiguration` captures whatever theme the app is in. Add a
  `light` class override on the `PrintOverlay` root if users ask.

## Ideas that came up during implementation (parked)

- Keyboard shortcuts surface (`Cmd+K` model switcher, `Cmd+Shift+O` new
  conversation, `Cmd+P` export current conversation to PDF).
- Conversation archiving (soft delete + "archived" list).
- Drag-reorder conversations within the Pinned group.
- Bulk export of selected conversations to a single markdown/zip.
- Share sheet for individual messages (not the whole conversation).
- Jump to a message in search results (today we only filter conversations).

## Cross-cutting quality items (tracked separately)

- [x] UI convention: binary settings → `<Toggle>`, multi-select lists →
      styled `<Checkbox>` (documented in `src/components/ui/toggle.tsx`
      header and in memory).
- [x] Masked API-key input (fixed 15-dot mask, click to edit).
- [x] Jump-to-latest floating button in message list.
- [x] Per-conversation streaming state + sidebar streaming indicator dot.
- [x] Model connectivity test (single + "Test all" with per-row pass/fail).
