#!/usr/bin/env bash
set -euo pipefail

REPO_NAME="${1:-pi-template}"
VISIBILITY="${2:-public}"

if gh repo view "gnoviawan/${REPO_NAME}" >/dev/null 2>&1; then
  echo "GitHub repo already exists: gnoviawan/${REPO_NAME}"
  exit 0
fi

gh repo create "gnoviawan/${REPO_NAME}" --"${VISIBILITY}" --source=. --remote=origin --push
