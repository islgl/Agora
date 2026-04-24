<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="./assets/logo-dark.png">
    <img src="./assets/logo-light.png" width="120" alt="Agora">
  </picture>
</p>

<h1 align="center">Agora</h1>

<p align="center">A desktop AI chat client with first-class agent tooling — built with Tauri, React, and Rust.</p>

<p align="center">
  <a href="https://agora.lglgl.me"><strong>agora.lglgl.me</strong></a>
</p>

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

> ⚠️ **Alpha.** Only a macOS build is published today (Apple Silicon). Binaries are ad-hoc signed — macOS asks once on first launch, right-click → Open to confirm.

## Highlights

- **Multi-provider chat** — Anthropic, OpenAI, Google via the Vercel AI SDK. Per-model config with live test.
- **Agent tooling** — nine first-party Rust tools (read/write/glob/grep/bash/…) scoped to a workspace root, plus MCP and Skills.
- **Personal assistant layers** — `config/` Brand (SOUL/USER/TOOLS/MEMORY/AGENTS), `wiki/` LLM-Wiki pages auto-generated from drops in `raw/`, HNSW vector memory with nightly Dreaming distillation.
- **Approvals & modes** — read-only auto-approve, per-tool allow rules, plan mode.
- **Conversation branching** — switch active leaves, explore alternatives without losing history.
- **Todos & hooks** — the agent can plan with structured todos and you can run shell hooks on lifecycle events.
- **Export & share** — Markdown, PDF, and a one-click share link for any conversation.
- **Everything local** — SQLite + files under `~/.agora/`, trivial to back up or clear.

## Install

Grab the [latest `.dmg`](https://github.com/islgl/agora/releases/latest) (Apple Silicon, ~16 MB) from [the homepage](https://agora.lglgl.me) or the [releases page](https://github.com/islgl/agora/releases) and drag `Agora.app` into `/Applications`.

The bundle is **ad-hoc signed** (not yet Developer-ID signed), so macOS will ask once on first launch:

1. Right-click `Agora.app` in `/Applications` → **Open**
2. Confirm the Gatekeeper prompt

From then on it launches like any other app. Intel Macs aren't packaged yet — build from source, or [open an issue](https://github.com/islgl/agora/issues) to nudge us.

## Development

Prerequisites: [Node ≥ 20](https://nodejs.org), [pnpm](https://pnpm.io), [Rust stable](https://rustup.rs), and the [Tauri system deps](https://tauri.app/start/prerequisites/).

```bash
pnpm install
pnpm tauri dev       # run the desktop app in dev mode
pnpm tauri build     # produce a release bundle under src-tauri/target/release/bundle/
```

### Releasing

CI builds the Apple Silicon `.dmg` automatically. Bump the version in `package.json`, `src-tauri/Cargo.toml`, and `src-tauri/tauri.conf.json`, update `CHANGELOG.md` and the homepage, then:

```bash
git tag v0.1.0-alpha.4
git push origin v0.1.0-alpha.4
```

The [`release` workflow](.github/workflows/release.yml) validates the three manifests against the tag, builds on `macos-14`, and attaches the `.dmg` to a **draft** GitHub Release ready for review. To exercise the pipeline without spending a version, trigger the workflow manually from the Actions tab — dry-runs skip the manifest check and the Release step, and only drop the `.dmg` as a workflow artifact.

Data layout:

```
~/.agora/
├── agora.db          # SQLite: conversations, messages, settings, memory_auto
├── config/           # Brand Layer (SOUL/USER/TOOLS/MEMORY/AGENTS.md)
├── wiki/             # LLM-Wiki pages, auto-maintained
├── raw/              # Drop files here for auto-ingest into wiki/
├── logs/             # Per-day conversation log (Dreaming input)
├── dreams/           # Candidate memories awaiting user review
├── skills/           # Skill packs
└── workspace/        # Default workspace root for FS/Bash tools
```

## License

[MIT](./LICENSE) © islgl
