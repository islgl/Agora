#!/usr/bin/env bash
# PreToolUse hook: require CHANGELOG.md update for commits being pushed to main.
# Reads the Bash tool-use payload on stdin. Exits 0 with a "deny"
# permissionDecision when enforcement triggers, 0 silently otherwise.

set -euo pipefail

input=$(cat)
cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // empty')

# Fast path: not a git push at all.
if ! printf '%s' "$cmd" | grep -qE '(^|[;&|[:space:]])git[[:space:]]+push\b'; then
  exit 0
fi

# Does this push target main?
#   explicit: `main`, `HEAD:main`, or `main:main` as a standalone token
#   implicit: no refspec given AND the current branch is main
targets_main=false
if printf '%s' "$cmd" | grep -qE '[[:space:]](main|HEAD:main|main:main)([[:space:]]|$)'; then
  targets_main=true
else
  branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || true)
  if [ "${branch:-}" = "main" ]; then
    # `git push` with no refspec (or just `git push origin`) — relies on upstream.
    # Heuristic: if there's no second positional arg after `origin`, call it main.
    if ! printf '%s' "$cmd" | grep -qE 'git[[:space:]]+push[[:space:]]+[^-[:space:]]+[[:space:]]+[^-[:space:]]'; then
      targets_main=true
    fi
  fi
fi

[ "$targets_main" = true ] || exit 0

# Need a fetched origin/main and a non-empty commit range to be meaningful.
git rev-parse origin/main >/dev/null 2>&1 || exit 0
range_count=$(git rev-list --count origin/main..HEAD 2>/dev/null || echo 0)
[ "${range_count:-0}" -gt 0 ] || exit 0

# Any commit in the range touched CHANGELOG.md?
if git log origin/main..HEAD --name-only --pretty=format: -- CHANGELOG.md 2>/dev/null | grep -q '[^[:space:]]'; then
  exit 0
fi

# Block — no CHANGELOG.md edit found in pending commits.
cat <<'JSON'
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "deny",
    "permissionDecisionReason": "推送到 main 前请在 CHANGELOG.md 的 [Unreleased] 段写一条 entry(或者,如果是在发版,把 [Unreleased] 里的条目搬到新版本段)。检测到本次待推送的所有 commit 都未修改 CHANGELOG.md。"
  }
}
JSON
exit 0
