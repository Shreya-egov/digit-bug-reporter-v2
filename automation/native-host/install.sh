#!/usr/bin/env bash
# Register the diagnosis helper with Chrome/Chromium for this user. Usage: install.sh <extension id> | --remove
# The extension id is shown on the tracker page (and in chrome://extensions).
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
NAME=org.digit.bug_triage
DIRS=("$HOME/.config/google-chrome/NativeMessagingHosts" "$HOME/.config/chromium/NativeMessagingHosts")
if [ "${1:-}" = "--remove" ]; then
  for d in "${DIRS[@]}"; do rm -f "$d/$NAME.json"; done
  echo "removed"; exit 0
fi
id="${1:?usage: install.sh <extension id> (copy it from the tracker page)}"
[[ "$id" =~ ^[a-p]{32}$ ]] || { echo "that doesn't look like an extension id (32 letters a-p)" >&2; exit 2; }
chmod +x "$HERE/digit_triage_host.py" "$HERE/../auto-triage.sh"
for d in "${DIRS[@]}"; do
  mkdir -p "$d"
  cat > "$d/$NAME.json" <<JSON
{
  "name": "$NAME",
  "description": "DIGIT Bug Reporter v2: start read-only bug diagnoses and read their results",
  "path": "$HERE/digit_triage_host.py",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://$id/"]
}
JSON
  echo "registered for $d"
done
echo "Reload the tracker page: it should say the diagnosis helper is connected."
