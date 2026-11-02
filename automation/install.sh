#!/usr/bin/env bash
# Install (or with --remove, remove) the 15-minute systemd user timer for auto-triage.sh.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
UNIT_DIR="$HOME/.config/systemd/user"
if [ "${1:-}" = "--remove" ]; then
  systemctl --user disable --now digit-auto-triage.timer 2>/dev/null || true
  rm -f "$UNIT_DIR/digit-auto-triage.service" "$UNIT_DIR/digit-auto-triage.timer"
  systemctl --user daemon-reload
  echo "removed"; exit 0
fi
mkdir -p "$UNIT_DIR"
sed "s|%h/digit-bug-reporter-v2/automation|$HERE|" "$HERE/digit-auto-triage.service" > "$UNIT_DIR/digit-auto-triage.service"
cp "$HERE/digit-auto-triage.timer" "$UNIT_DIR/"
systemctl --user daemon-reload
systemctl --user enable --now digit-auto-triage.timer
systemctl --user list-timers digit-auto-triage.timer --no-pager
