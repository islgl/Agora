#!/usr/bin/env bash
# PreToolUse hook: when a version bump lands on main, require the homepage
# (docs/index.html + _design/homepage/app.src.jsx) to reference the new
# version too. The homepage carries the CTA version pill and the .dmg
# download URL, so a release that forgets this step points users at the
# previous build.

set -euo pipefail

input=$(cat)
cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // empty')

# Fast path: not a git push.
if ! printf '%s' "$cmd" | grep -qE '(^|[;&|[:space:]])git[[:space:]]+push\b'; then
  exit 0
fi

# Target main? (explicit refspec or implicit via current branch)
targets_main=false
if printf '%s' "$cmd" | grep -qE '[[:space:]](main|HEAD:main|main:main)([[:space:]]|$)'; then
  targets_main=true
else
  branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || true)
  if [ "${branch:-}" = "main" ]; then
    # `git push` with no refspec (or just `git push origin`) — relies on upstream.
    if ! printf '%s' "$cmd" | grep -qE 'git[[:space:]]+push[[:space:]]+[^-[:space:]]+[[:space:]]+[^-[:space:]]'; then
      targets_main=true
    fi
  fi
fi
[ "$targets_main" = true ] || exit 0

# Need a fetched origin/main and a non-empty commit range to compare against.
git rev-parse origin/main >/dev/null 2>&1 || exit 0
range_count=$(git rev-list --count origin/main..HEAD 2>/dev/null || echo 0)
[ "${range_count:-0}" -gt 0 ] || exit 0

# Did any pending commit touch package.json? Skip otherwise.
if ! git log origin/main..HEAD --name-only --pretty=format: -- package.json 2>/dev/null | grep -q '[^[:space:]]'; then
  exit 0
fi

# Did the version field actually change? Touching other fields (deps, scripts)
# is not a release signal.
old_pkg_version=$(git show origin/main:package.json 2>/dev/null | jq -r '.version // empty' 2>/dev/null || true)
new_pkg_version=$(jq -r '.version // empty' package.json 2>/dev/null || true)
[ -n "${new_pkg_version:-}" ] || exit 0
[ "${old_pkg_version:-}" != "${new_pkg_version}" ] || exit 0

# Release push detected. Inspect homepage references.
issues=()

docs_file="docs/index.html"
if [ -f "$docs_file" ]; then
  # The compiled bundle encodes the release URL literally.
  docs_version=$(grep -oE 'releases/download/v[0-9][0-9A-Za-z.+-]*/' "$docs_file" | head -1 | sed 's|releases/download/v||; s|/$||' || true)
  if [ -n "${docs_version:-}" ] && [ "$docs_version" != "$new_pkg_version" ]; then
    issues+=("docs/index.html 下载链接仍指向 v${docs_version}")
  fi
fi

src_file="_design/homepage/app.src.jsx"
if [ -f "$src_file" ]; then
  src_version=$(grep -oE "VERSION = '[^']+'" "$src_file" | head -1 | sed "s/VERSION = '//; s/'$//" || true)
  if [ -n "${src_version:-}" ] && [ "$src_version" != "$new_pkg_version" ]; then
    issues+=("_design/homepage/app.src.jsx VERSION 仍是 '${src_version}'")
  fi
fi

[ ${#issues[@]} -gt 0 ] || exit 0

joined=$(printf '  · %s\n' "${issues[@]}")
reason=$(printf '发版提示: package.json 已升到 %s，但 homepage 还没同步：\n%s\n请更新 _design/homepage/app.src.jsx 的 VERSION 和 DMG_URL，重新编译到 docs/index.html，再把改动一起带上本次推送。' "$new_pkg_version" "$joined")

jq -n --arg reason "$reason" '{
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason: $reason
  }
}'
exit 0
