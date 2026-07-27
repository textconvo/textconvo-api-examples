#!/usr/bin/env bash
#
# TextConvo — retry with exponential backoff and jitter, and rate-limit handling
#
# The key idea: the SAME X-Request-Id is reused on every attempt. That header is
# the idempotency key, so a retry after a timeout returns the original result
# with "duplicate": true instead of creating a second lead.
#
# Retry:      429, 500, 502, 503, 504, and connection failures
# Never retry: 400, 401, 403 — they will fail identically forever
#
# Docs: https://textconvo.ai/docs#rate-limits  |  https://textconvo.ai/docs#error-codes

set -uo pipefail

if [ -f "../../.env" ]; then
  set -a; . "../../.env"; set +a
fi

BASE_URL="${TEXTCONVO_BASE_URL:-https://api.textconvo.ai}"
API_KEY="${TEXTCONVO_API_KEY:?Set TEXTCONVO_API_KEY}"
SOURCE_KEY="${TEXTCONVO_SOURCE_KEY:?Set TEXTCONVO_SOURCE_KEY}"

MAX_ATTEMPTS=5
REQUEST_ID="$(uuidgen)"          # generated ONCE, on purpose
PHONE="${1:-+15035551234}"
BODY="{\"phone\":\"$PHONE\",\"first_name\":\"Jane\",\"last_name\":\"Doe\"}"

echo "Request id (stable across retries): $REQUEST_ID"

attempt=1
while [ "$attempt" -le "$MAX_ATTEMPTS" ]; do
  RESPONSE="$(curl -sS -X POST "$BASE_URL/functions/v1/ingest-lead" \
    -H "Content-Type: application/json" \
    -H "X-API-Key: $API_KEY" \
    -H "X-Source-Key: $SOURCE_KEY" \
    -H "X-Request-Id: $REQUEST_ID" \
    -d "$BODY" \
    -w "\n%{http_code}" 2>/dev/null)"

  STATUS="$(echo "$RESPONSE" | tail -n1)"
  PAYLOAD="$(echo "$RESPONSE" | sed '$d')"

  echo "Attempt $attempt — HTTP ${STATUS:-000}"

  case "${STATUS:-000}" in
    202)
      echo "$PAYLOAD"
      echo "Accepted. Watch for webhooks: https://textconvo.ai/docs#webhooks"
      exit 0
      ;;
    400|401|403|404|422)
      echo "$PAYLOAD"
      echo "Permanent failure — not retrying. Fix the request."
      exit 1
      ;;
    429)
      # Prefer the server hint. Defaults are 60 requests/minute and 10/second.
      RETRY_AFTER="$(echo "$PAYLOAD" | grep -o '"retry_after"[[:space:]]*:[[:space:]]*[0-9]*' | grep -o '[0-9]*$')"
      WAIT="${RETRY_AFTER:-$((2 ** attempt))}"
      echo "Rate limited. Waiting ${WAIT}s as instructed."
      ;;
    000|5*)
      # Exponential backoff with full jitter: random between 0 and 2^attempt,
      # capped at 30 seconds. Jitter stops every client retrying in lockstep.
      CAP="$((2 ** attempt))"
      [ "$CAP" -gt 30 ] && CAP=30
      WAIT="$((RANDOM % CAP + 1))"
      echo "Transient failure. Backing off ${WAIT}s."
      ;;
    *)
      echo "$PAYLOAD"
      echo "Unexpected status — not retrying."
      exit 1
      ;;
  esac

  sleep "$WAIT"
  attempt=$((attempt + 1))
done

echo "Giving up after $MAX_ATTEMPTS attempts. Request id $REQUEST_ID — quote it to support."
exit 1
