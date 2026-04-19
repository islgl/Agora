# Changelog

All notable changes to Agora will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Push-to-main CHANGELOG guard** — `.claude/hooks/require-changelog-on-push.sh` registered as a Claude Code PreToolUse hook via `.claude/settings.json`. Blocks `git push … main` when none of the pending commits touched `CHANGELOG.md`, keeping release notes in lockstep with the tree.

### Changed

- **Move logo assets to repo-root `assets/`** — `./assets/logo-{light,dark}.png` are now the canonical paths referenced by the README header.
- **`docs/` is now local-only** — internal design notes, roadmap, and TODO live outside of git (`docs/` is in `.gitignore`). The README no longer advertises a Documentation section.

### Fixed

- **Active model persists across restarts** — clicking *Use* in Settings → Models now writes the selected model id into `global_settings.active_model_id` (new column), and startup reads it back before the "pick a fallback" logic runs. Previously, *Use* was in-memory-only and a restart fell back to the first model in the list.

## [0.1.0-alpha.1] — 2026-04-19

### Changed

- **Ad-hoc sign the macOS bundle** (`bundle.macOS.signingIdentity = "-"`) so Gatekeeper no longer rejects the `.dmg` with the misleading "damaged" message. Users on a fresh download only need `right-click → Open` once; the `xattr -dr com.apple.quarantine` workaround is no longer required.

## [0.1.0-alpha] — 2026-04-19

First public preview. Everything stored locally under `~/.agora/`.

### Added

- **Chat runtime** on top of the Vercel AI SDK with Anthropic, OpenAI, and Google providers; per-model configuration and live test.
- **Built-in agent tools** (Rust): `read_file`, `write_file`, `edit_file`, `glob`, `grep`, `bash`, `bash_background`, `read_task_output`, `stop_task` — all scoped to a workspace root.
- **MCP support** — connect external Model Context Protocol servers, persisted and reconnected on launch.
- **Skills** — load markdown-based skill packs from `~/.agora/skills/`; optional script execution gated by a global toggle.
- **Conversation branching** — switch active leaves without losing alternative histories.
- **Agent capabilities** — approval prompts with per-tool allow rules, auto-approve for read-only tools, structured todos, conversation modes (including plan mode), subagents, lifecycle hooks.
- **Export & share** — Markdown and PDF export, plus a share-conversation command.
- **Search** — full-text search across conversations.
- **Default workspace root** — `~/.agora/workspace` applied on first launch so FS/Bash tools have scope without setup; editable via **Settings → General** (type/paste a path or use the directory picker).
- **Legacy-data migration** — one-shot move from `~/Library/Application Support/com.agora.app/` to `~/.agora/` on upgrade.

### Known limitations

- macOS build only; binaries are unsigned (expect a Gatekeeper prompt on first launch).
- No auto-update channel yet — grab new versions from [Releases](https://github.com/islgl/agora/releases).
- Cross-platform builds (Windows / Linux) are planned once CI is wired up.

[Unreleased]: https://github.com/islgl/agora/compare/v0.1.0-alpha.1...HEAD
[0.1.0-alpha.1]: https://github.com/islgl/agora/compare/v0.1.0-alpha...v0.1.0-alpha.1
[0.1.0-alpha]: https://github.com/islgl/agora/releases/tag/v0.1.0-alpha
