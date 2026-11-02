#!/usr/bin/env bash
# Back up an MDMS record and show the diff of a proposed version. Never writes: there is no --apply path here.
# Usage: mdms-dryrun.sh <env> backup <schema> <uid> <out-dir>
#        mdms-dryrun.sh <env> diff <new.json> <base.json>
set -euo pipefail
M="$HOME/.claude/skills/mdms-qa/scripts/mdms.py"
env="${1:?env}"; action="${2:?backup|diff}"; shift 2
for a in "$@"; do [ "$a" = "--apply" ] || [ "$a" = "--uuid" ] && { echo "mdms-dryrun.sh never writes" >&2; exit 2; }; done
case "$action" in
  backup) python3 "$M" --env "$env" backup "${1:?schema}" "${2:?uid}" --out "${3:?out-dir}" ;;
  diff)   python3 "$M" --env "$env" update "${1:?new.json}" --base "${2:?base.json}" ;;
  *) echo "unknown action: $action" >&2; exit 2 ;;
esac
