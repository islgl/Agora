<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="./docs/assets/logo-dark.png">
    <img src="./docs/assets/logo-light.png" width="120" alt="Agora">
  </picture>
</p>

<h1 align="center">Agora</h1>

<p align="center">A desktop AI chat client with first-class agent tooling — built with Tauri, React, and Rust.</p>

<p align="center">
  <a href="https://github.com/islgl/agora/releases"><img src="https://img.shields.io/github/v/release/islgl/agora?include_prereleases&label=version&color=blue" alt="Version"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/github/license/islgl/agora?color=green" alt="License"></a>
  <a href="https://github.com/islgl/agora/releases"><img src="https://img.shields.io/badge/platform-macOS-000?logo=apple&logoColor=white" alt="Platform"></a>
  <a href="https://tauri.app"><img src="https://img.shields.io/badge/Tauri-2-24C8DB?logo=tauri&logoColor=white" alt="Tauri"></a>
  <a href="https://react.dev"><img src="https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=white" alt="React"></a>
  <a href="https://www.typescriptlang.org"><img src="https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript&logoColor=white" alt="TypeScript"></a>
  <a href="https://www.rust-lang.org"><img src="https://img.shields.io/badge/Rust-stable-DEA584?logo=rust&logoColor=white" alt="Rust"></a>
</p>

Agora pairs a clean chat UI with a real agent runtime: MCP servers, skills, built-in FS/Bash/Grep tools, approval prompts, todos, hooks, and conversation branching — all stored locally under `~/.agora/`.

> ⚠️ **Alpha.** Only a macOS build is published today. Binaries are unsigned — Gatekeeper will prompt on first launch.

## Highlights

- **Multi-provider chat** — Anthropic, OpenAI, Google via the Vercel AI SDK. Per-model config with live test.
- **Agent tooling** — nine first-party Rust tools (read/write/glob/grep/bash/…) scoped to a workspace root, plus MCP and Skills.
- **Approvals & modes** — read-only auto-approve, per-tool allow rules, plan mode.
- **Conversation branching** — switch active leaves, explore alternatives without losing history.
- **Todos & hooks** — the agent can plan with structured todos and you can run shell hooks on lifecycle events.
- **Export & share** — Markdown, PDF, and a one-click share link for any conversation.
- **Everything local** — SQLite + files under `~/.agora/`, trivial to back up or clear.

## Install

Grab the latest `.dmg` from [Releases](https://github.com/islgl/agora/releases) and drag `Agora.app` into `/Applications`.

Because the alpha isn't signed with an Apple Developer ID, macOS may refuse to launch it. Run this once after copying:

```bash
xattr -dr com.apple.quarantine /Applications/Agora.app
```

Then double-click normally. The quarantine bit is what macOS adds to everything downloaded from the internet; removing it tells Gatekeeper to trust you on this one.

> Future releases (v0.1.1-alpha+) ship ad-hoc signed, so you'll only need `right-click → Open` once instead of the `xattr` command.

## Development

Prerequisites: [Node ≥ 20](https://nodejs.org), [pnpm](https://pnpm.io), [Rust stable](https://rustup.rs), and the [Tauri system deps](https://tauri.app/start/prerequisites/).

```bash
pnpm install
pnpm tauri dev       # run the desktop app in dev mode
pnpm tauri build     # produce a release bundle under src-tauri/target/release/bundle/
```

Data layout:

```
~/.agora/
├── agora.db          # SQLite: conversations, messages, settings
├── skills/           # Skill packs
└── workspace/        # Default workspace root for FS/Bash tools
```

## Documentation

Design notes and internal docs live under [`docs/`](./docs):

- [`DESIGN.md`](./docs/DESIGN.md) — visual system & product direction
- [`TOOLS.md`](./docs/TOOLS.md) — the nine built-in tools
- [`AGENT_ROADMAP.md`](./docs/AGENT_ROADMAP.md) — where the agent story is headed
- [`TODO.md`](./docs/TODO.md) — candidate features

See [`CHANGELOG.md`](./CHANGELOG.md) for release history.

## License

[MIT](./LICENSE) © islgl
