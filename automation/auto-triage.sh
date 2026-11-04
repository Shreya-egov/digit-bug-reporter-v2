#!/usr/bin/env bash
# Diagnose new DIGIT-Frontend bugs automatically, read-only.
#   auto-triage.sh            new open issues you filed (run by the systemd timer)
#   auto-triage.sh <url>      one issue, now (also started by the extension's native host when you click Create)
# For each issue, Claude Code runs the fix-ui-bug skill in mode=diagnose with a read-only allowlist and no GitHub
# token, writes report.md / comment.md / mdms/ to ~/digit-bug-triage/<repo>-<n>/, and you get a desktop notification.
# Nothing is written to MDMS, GitHub or any repo: applying a fix is a separate, interactive /fix-ui-bug run.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
SKILL="$(dirname "$HERE")/claude-skills/fix-ui-bug/SKILL.md"
REPO=${DIGIT_TRIAGE_REPO:-egovernments/DIGIT-Frontend}
AUTHOR=${DIGIT_TRIAGE_AUTHOR:-$(git config --global user.name 2>/dev/null || true)}
OUT=${DIGIT_TRIAGE_OUT:-$HOME/digit-bug-triage}
STATE=${XDG_STATE_HOME:-$HOME/.local/state}/digit-auto-triage
SINCE_DAYS=${DIGIT_TRIAGE_SINCE_DAYS:-2}
MAX_PER_RUN=${DIGIT_TRIAGE_MAX:-3} # each diagnosis is a full Claude Code run, so cap them
CLAUDE=${CLAUDE_BIN:-$(command -v claude || echo "$HOME/.local/bin/claude")}
mkdir -p "$OUT" "$STATE"
touch "$STATE/seen"

KNOWN="$OUT/known-causes.md" # one line per past verdict; each run reads it first

notify() { command -v notify-send >/dev/null && notify-send -a "DIGIT auto-triage" "$1" "$2" || true; echo "$1: $2"; }

# Read-only allowlist. Anything not listed is denied, because nobody is there to approve it.
write_settings() {
  local env cmds=()
  local skills
  # the skills' docs write ~/.claude/...; both spellings must match
  for skills in "$HOME/.claude/skills" "~/.claude/skills"; do
    cmds+=("\"Bash($skills/mdms-qa/scripts/pf.sh:*)\""
           "\"Bash(python3 $skills/app-config-check/scripts/fields.py:*)\""
           "\"Bash($skills/github-bug/scripts/envinfo.sh:*)\"")
    for env in qa uat demo; do
      cmds+=("\"Bash(python3 $skills/mdms-qa/scripts/mdms.py --env $env get:*)\""
             "\"Bash(python3 $skills/mdms-qa/scripts/mdms.py --env $env search:*)\""
             "\"Bash(python3 $skills/mdms-qa/scripts/mdms.py --env $env --tenant:*)\"")
    done
  done
  for env in qa uat demo; do cmds+=("\"Bash(kubectl --context $env get:*)\""); done
  for g in fetch show grep log diff cat-file rev-parse branch ls-tree remote; do
    cmds+=("\"Bash(git -C $HOME/DIGIT-Frontend $g:*)\"")
  done
  local IFS=,
  cat > "$STATE/settings.json" <<JSON
{ "permissions": {
    "allow": [
      "Read", "Grep", "Glob",
      "Write(/$OUT/**)", "Edit(/$OUT/**)",
      "Bash($HERE/gh-get.sh:*)", "Bash($HERE/fetch-attachment.sh:*)", "Bash($HERE/mdms-dryrun.sh:*)",
      "Bash($HERE/extract-frames.sh:*)",
      ${cmds[*]}
    ],
    "deny": ["WebFetch", "WebSearch", "NotebookEdit"]
} }
JSON
}

# Dir name and markers are read by the native host: .running while a run is going, .failed if it produced no report.
issue_dir() { local u=${1#https://github.com/}; local repo=${u#*/}; repo=${repo%%/*}; echo "$OUT/$repo-${1##*/}"; }

diagnose() {
  local url=$1 n=${1##*/} dir
  dir=$(issue_dir "$url")
  mkdir -p "$dir"
  # one run per issue, whether started by the timer or by the extension
  exec 8>"$dir/.lock"
  flock -n 8 || { echo "#$n is already being diagnosed"; return 0; }
  echo $$ > "$dir/.running"
  rm -f "$dir/.failed"
  notify "Diagnosing #$n" "$url"
  local frames=""
  [ -d "$dir/attachments/frames" ] && frames="
Frames from the screen recording, in order, are in $dir/attachments/frames/: look at them to follow the steps."
  local prompt="Diagnose the bug $url with the fix-ui-bug skill in automatic diagnosis mode.
Read the skill at $SKILL and follow its 'Automatic diagnosis' section: mode=diagnose repo=$REPO out=$dir.
Before anything else, read $KNOWN if it exists: verdicts from earlier bugs. If this bug matches one, check that cause
first and cite it, but confirm it with this bug's own evidence.$frames
Helpers (use these instead of curl): $HERE/gh-get.sh <api path>, $HERE/fetch-attachment.sh <url> <file name>,
$HERE/extract-frames.sh <attachment file name>, $HERE/mdms-dryrun.sh <env> backup|diff ... .
The DIGIT-Frontend clone is $HOME/DIGIT-Frontend: read it with git -C (fetch, show, grep, log); never check out or
modify it. Write report.md and comment.md in $dir.
Run scripts by absolute path, one command per call, e.g. $HOME/.claude/skills/mdms-qa/scripts/pf.sh start qa and
python3 $HOME/.claude/skills/mdms-qa/scripts/mdms.py --env qa get <schema> <uid> (not ~ or shell variables)."
  ( cd "$dir" && DIGIT_TRIAGE_ISSUE_DIR="$dir" env -u GITHUB_TOKEN -u GH_TOKEN \
      "$CLAUDE" -p "$prompt" --settings "$STATE/settings.json" --add-dir "$dir" > "$dir/run.log" 2>&1 ) || true
  # don't leave a port-forward behind if the run didn't stop it
  for env in qa uat demo; do "$HOME/.claude/skills/mdms-qa/scripts/pf.sh" stop "$env" >/dev/null 2>&1 || true; done
  rm -f "$dir/.running"
  if [ -s "$dir/report.md" ]; then
    grep -qxF "$url" "$STATE/seen" || echo "$url" >> "$STATE/seen"
    local verdict
    verdict=$(head -1 "$dir/report.md" | sed 's/^VERDICT: *//' | cut -c1-200)
    echo "- $(date +%F) $url: $verdict" >> "$KNOWN"
    tail -n 100 "$KNOWN" > "$KNOWN.tmp" && mv "$KNOWN.tmp" "$KNOWN"
    notify "#$n: $(echo "$verdict" | cut -c1-120)" "Report: $dir/report.md"
  else
    touch "$dir/.failed"
    echo "$url $(date +%s)" >> "$STATE/failed"
    notify "#$n: diagnosis failed" "See $dir/run.log"
  fi
}

write_settings
if [ $# -gt 0 ]; then
  [[ "$1" =~ ^https://github\.com/[^/]+/[^/]+/issues/[0-9]+$ ]] || { echo "usage: $0 [issue-url]" >&2; exit 2; }
  diagnose "$1"
  exit 0
fi

[ -n "$AUTHOR" ] || { echo "set DIGIT_TRIAGE_AUTHOR to your GitHub username" >&2; exit 2; }
since=$(date -d "-$SINCE_DAYS days" +%F)
urls=$("$HERE/gh-get.sh" "/search/issues?q=repo:$REPO+is:issue+is:open+author:$AUTHOR+created:%3E%3D$since&per_page=20" \
  | python3 -c 'import json,sys; [print(i["html_url"]) for i in json.load(sys.stdin)["items"] if "pull_request" not in i]')
count=0
for url in $urls; do
  grep -qxF "$url" "$STATE/seen" && continue
  # give up after two failed attempts on the same issue
  [ "$(grep -c "^$url " "$STATE/failed" 2>/dev/null || true)" -ge 2 ] && continue
  [ "$count" -ge "$MAX_PER_RUN" ] && break
  diagnose "$url"
  count=$((count + 1))
done
echo "checked $(echo "$urls" | grep -c . || true) open issue(s) since $since, diagnosed $count"
