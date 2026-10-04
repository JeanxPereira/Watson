#!/usr/bin/env bash
# upsert-issue.sh <title> <report.md>
# Opens one issue with this exact title, or rewrites the body of the open one: a scheduled run
# that fails every day keeps one issue current instead of piling up comments.
# Needs GH_TOKEN, REPOSITORY and RUN (the run's URL) in the environment.
set -euo pipefail
title=$1
report=$2

body=$(mktemp)
{
  echo "Run: $RUN"
  echo
  head -c 60000 "$report"
  if [ "$(wc -c < "$report")" -gt 60000 ]; then
    echo
    echo "(report cut at 60000 bytes; the whole one is the run's hooks-report artifact)"
  fi
} > "$body"

number=$(gh issue list --repo "$REPOSITORY" --state open --search "\"$title\" in:title" --json number,title \
  --jq "map(select(.title == \"$title\")) | .[0].number // empty")
if [ -n "$number" ]; then
  gh issue edit "$number" --repo "$REPOSITORY" --body-file "$body"
  echo "updated issue #$number"
else
  gh issue create --repo "$REPOSITORY" --title "$title" --body-file "$body"
fi
