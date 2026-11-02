#!/usr/bin/env bash
# Read-only GitHub API GET for the automatic diagnosis. No token, no other hosts, no other methods.
# Usage: gh-get.sh /repos/<owner>/<repo>/issues/<n>[/comments|/timeline]
set -euo pipefail
path="${1:?usage: gh-get.sh /repos/owner/repo/...}"
[[ "$path" =~ ^/(repos/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+(/[A-Za-z0-9_./-]*)?|search/issues)(\?[A-Za-z0-9_=:+%.&-]*)?$ ]] \
  || { echo "gh-get.sh: path not allowed: $path" >&2; exit 2; }
exec curl -sSf --max-time 30 -H 'Accept: application/vnd.github+json' "https://api.github.com$path"
