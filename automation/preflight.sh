#!/usr/bin/env bash
# What the automatic diagnosis can use on this machine. Prints JSON (read by auto-triage.sh and the native host).
# Nothing here is required except Claude Code: missing pieces only narrow what the diagnosis can check.
set -uo pipefail
SKILLS=${DIGIT_TRIAGE_SKILLS:-$HOME/.claude/skills}
CLONE=${DIGIT_FRONTEND_DIR:-$HOME/DIGIT-Frontend}
CACHE_CLONE="$HOME/.cache/digit-bug-reporter/DIGIT-Frontend"
CLAUDE=${CLAUDE_BIN:-$(command -v claude || echo "$HOME/.local/bin/claude")}

clone=""
for d in "$CLONE" "$CACHE_CLONE"; do
  git -C "$d" remote get-url origin 2>/dev/null | grep -q 'egovernments/DIGIT-Frontend' && { clone=$d; break; }
done
contexts=()
if command -v kubectl >/dev/null; then
  for c in qa uat demo; do kubectl config get-contexts -o name 2>/dev/null | grep -qx "$c" && contexts+=("\"$c\""); done
fi
has() { [ -e "$1" ] && echo true || echo false; }
ctx=$(IFS=,; echo "${contexts[*]:-}")
cat <<JSON
{"claude": $(has "$CLAUDE"), "clone": "${clone}", "cacheClone": "$CACHE_CLONE",
 "clusterContexts": [${ctx}], "mdmsTools": $(has "$SKILLS/mdms-qa/scripts/mdms.py"),
 "appConfigTools": $(has "$SKILLS/app-config-check/scripts/fields.py"), "envTools": $(has "$SKILLS/github-bug/scripts/envinfo.sh"),
 "ffmpeg": $(command -v ffmpeg >/dev/null && echo true || echo false), "skills": "$SKILLS"}
JSON
