#!/usr/bin/env bash
#
# TextConvo — ingest a lead with cURL
#
# Docs: https://textconvo.ai/docs#lead-ingestion-api
# Auth: https://textconvo.ai/docs#authentication
#
# Usage:
#   cp ../../.env.example ../../.env && edit it
#   ./ingest-lead.sh "+15035551234" "Jane" "Doe" "jane.doe@example.com"
#
# Requires: bash, curl, uuidgen (or python3 as a fallback)

set -euo pipefail

# --- Configuration ---------------------------------------------------------
# Load .env from the repository root if it exists.
if [ -f "../../.env" ]; then
  set -a; . "../../.env"; set +a
fi

BASE_URL="${TEXTCONVO_BASE_URL:-https://api.textconvo.ai}"
API_KEY="${TEXTCONVO_API_KEY:?Set TEXTCONVO_API_KEY in your environment}"
SOURCE_KEY="${TEXTCONVO_SOURCE_KEY:?Set TEXTCONVO_SOURCE_KEY in your environment}"

# --- Input -----------------------------------------------------------------
PHONE="${1:-+15035551234}"      # REQUIRED by the API, E.164 format
FIRST_NAME="${2:-Jane}"
LAST_NAME="${3:-Doe}"
EMAIL="${4:-jane.doe@example.com}"

# --- Idempotency key -------------------------------------------------------
# X-Request-Id makes retries safe: the same id returns the original result
# with "duplicate": true instead of ingesting the lead twice.
if command -v uuidgen >/dev/null 2>&1; then
  REQUEST_ID="$(uuidgen)"
else
  REQUEST_ID="$(python3 -c 'import uuid; print(uuid.uuid4())')"
fi

echo "POST $BASE_URL/functions/v1/ingest-lead"
echo "X-Request-Id: $REQUEST_ID"

# --- Request ---------------------------------------------------------------
# Only "phone" is required. Any non-standard field must be nested inside
# custom_fields — unknown top-level fields are rejected by the whitelist.
BODY=$(cat <<JSON
{
  "phone": "$PHONE",
  "first_name": "$FIRST_NAME",
  "last_name": "$LAST_NAME",
  "email": "$EMAIL",
  "external_id": "crm_00042",
  "city": "Portland",
  "state": "OR",
  "zip": "97204",
  "landing_page": "https://example.com/quote",
  "metadata": { "campaign": "spring-promo" },
  "custom_fields": { "roof_age_years": "12" }
}
JSON
)

# -s quiet, -S still show errors, -w capture the status code on its own line.
RESPONSE=$(curl -sS -X POST "$BASE_URL/functions/v1/ingest-lead" \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $API_KEY" \
  -H "X-Source-Key: $SOURCE_KEY" \
  -H "X-Request-Id: $REQUEST_ID" \
  -d "$BODY" \
  -w "\n%{http_code}")

STATUS="$(echo "$RESPONSE" | tail -n1)"
PAYLOAD="$(echo "$RESPONSE" | sed '$d')"

echo "HTTP $STATUS"
echo "$PAYLOAD"

# --- Error handling --------------------------------------------------------
# See https://textconvo.ai/docs#error-codes
case "$STATUS" in
  202)
    echo "OK — lead accepted and queued. A journey will start per your configuration."
    ;;
  400)
    echo "Bad request. Check the error code in the payload — for example"
    echo "MISSING_REQUIRED_FIELD when phone is absent, or a non-whitelisted"
    echo "top-level field that belongs in custom_fields. Do not retry as-is."
    exit 1
    ;;
  401)
    echo "Unauthorized. Check X-API-Key. Do not retry as-is."
    exit 1
    ;;
  403)
    echo "Forbidden. This key lacks permission for that source key."
    exit 1
    ;;
  429)
    echo "Rate limited. Defaults are 60 requests/minute and 10/second per key."
    echo "Honour retry_after in the payload, then retry with the SAME X-Request-Id."
    exit 1
    ;;
  5*)
    echo "Server error. Retry with backoff, same X-Request-Id. See retry-with-backoff.sh"
    exit 1
    ;;
  *)
    echo "Unexpected status."
    exit 1
    ;;
esac
