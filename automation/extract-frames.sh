#!/usr/bin/env bash
# Extract up to 20 frames (one every 3 s) from a downloaded recording, for the automatic diagnosis.
# Usage: extract-frames.sh <file name in attachments/>. Needs ffmpeg; frames from extension reports arrive without it.
set -euo pipefail
dir="${DIGIT_TRIAGE_ISSUE_DIR:?run from auto-triage.sh}"
name="${1:?file name}"
[[ "$name" =~ ^[A-Za-z0-9_.-]+$ ]] || { echo "extract-frames.sh: bad file name" >&2; exit 2; }
command -v ffmpeg >/dev/null || { echo "ffmpeg is not installed: can't read the video (sudo apt install ffmpeg)" >&2; exit 3; }
mkdir -p "$dir/attachments/frames"
ffmpeg -loglevel error -y -i "$dir/attachments/$name" -vf fps=1/3,scale=960:-2 -frames:v 20 "$dir/attachments/frames/%02d.jpg"
ls "$dir/attachments/frames"
