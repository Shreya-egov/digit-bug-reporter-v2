#!/usr/bin/env bash
# Download one GitHub issue attachment into the diagnosis folder. Usage: fetch-attachment.sh <url> <file name>
set -euo pipefail
url="${1:?url}"; name="${2:?file name}"
out="${DIGIT_TRIAGE_ISSUE_DIR:?run from auto-triage.sh}"
[[ "$url" =~ ^https://(github\.com/user-attachments/(assets|files)/[A-Za-z0-9/_.-]+|private-user-images\.githubusercontent\.com/[A-Za-z0-9/_.?=&%-]+)$ ]] \
  || { echo "fetch-attachment.sh: not a GitHub attachment URL" >&2; exit 2; }
[[ "$name" =~ ^[A-Za-z0-9_.-]+$ ]] || { echo "fetch-attachment.sh: bad file name" >&2; exit 2; }
mkdir -p "$out/attachments"
curl -sSfL --max-time 60 --max-filesize 30000000 -o "$out/attachments/$name" "$url"
file "$out/attachments/$name"
