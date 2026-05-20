#!/usr/bin/env bash
# Railway GraphQL API helper
# Usage: railway-api.sh '<graphql-query>' ['<variables-json>']
#
# Authenticates against backboard.railway.com/graphql/v2. Resolves a token in
# least-privilege-first order — if both a project-scoped and a full-account
# token are set, the project-scoped one wins so read-only diagnostics never
# silently run with broader privileges:
#   1. $RAILWAY_READONLY_TOKEN     → project-access token (Project-Access-Token)
#   2. $RAILWAY_PROJECT_TOKEN      → project-access token (Project-Access-Token)
#   3. $RAILWAY_TOKEN              → user/team token (Authorization: Bearer)
#   4. ~/.railway/config.json      → CLI-stored user token (Authorization: Bearer)
#
# Project-access tokens are scoped to one project + environment and cannot
# call account-level queries like `me { ... }` — use `projectToken { ... }`
# to discover their scope.

set -e

if ! command -v jq &>/dev/null; then
  echo '{"error": "jq not installed. Install with: brew install jq"}'
  exit 1
fi

TOKEN=""
AUTH_HEADER=""

if [[ -n "$RAILWAY_READONLY_TOKEN" ]]; then
  TOKEN="$RAILWAY_READONLY_TOKEN"
  AUTH_HEADER="Project-Access-Token: $TOKEN"
elif [[ -n "$RAILWAY_PROJECT_TOKEN" ]]; then
  TOKEN="$RAILWAY_PROJECT_TOKEN"
  AUTH_HEADER="Project-Access-Token: $TOKEN"
elif [[ -n "$RAILWAY_TOKEN" ]]; then
  TOKEN="$RAILWAY_TOKEN"
  AUTH_HEADER="Authorization: Bearer $TOKEN"
else
  CONFIG_FILE="$HOME/.railway/config.json"
  if [[ -f "$CONFIG_FILE" ]]; then
    TOKEN=$(jq -r '.user.token // empty' "$CONFIG_FILE")
    if [[ -n "$TOKEN" ]]; then
      AUTH_HEADER="Authorization: Bearer $TOKEN"
    fi
  fi
fi

if [[ -z "$TOKEN" ]]; then
  echo '{"error": "No Railway credentials found. Set $RAILWAY_TOKEN (user/team), $RAILWAY_READONLY_TOKEN / $RAILWAY_PROJECT_TOKEN (project), or run: railway login"}'
  exit 1
fi

if [[ -z "$1" ]]; then
  echo '{"error": "No query provided"}'
  exit 1
fi

# Build payload with query and optional variables
if [[ -n "$2" ]]; then
  PAYLOAD=$(jq -n --arg q "$1" --argjson v "$2" '{query: $q, variables: $v}')
else
  PAYLOAD=$(jq -n --arg q "$1" '{query: $q}')
fi

curl -s https://backboard.railway.com/graphql/v2 \
  -H "$AUTH_HEADER" \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD"
