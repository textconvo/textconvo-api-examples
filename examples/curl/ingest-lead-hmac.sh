#!/usr/bin/env bash
#
# TextConvo — signed request (HMAC-SHA256)
#
# HMAC signing is optional and enabled per source. When it is on, send two
# extra headers so TextConvo can prove the body was not altered in transit.
#
# Docs: https://textconvo.ai/docs#hmac-authentication
#
# The signed string is:  timestamp + "." + rawBody
# The signature is:      hex(HMAC_SHA256(key = HMAC_SECRET, data = signed string))
#
# Two rules that catch everyone out:
#   1. Sign the EXACT bytes you send. Serialise once, sign that string, send that string.
#   2. The timestamp must be within 300 seconds of server time.
#
# Requires: bash, curl, openssl, uuidgen

set -euo pipefail

if [ -f "../../.env" ]; then
  set -a; . "../../.env"; set +a
fi

BASE_URL="${TEXTCONVO_BASE_URL:-https://api.textconvo.ai}"
API_KEY="${TEXTCONVO_API_KEY:?Set TEXTCONVO_API_KEY}"
SOURCE_KEY="${TEXTCONVO_SOURCE_KEY:?Set TEXTCONVO_SOURCE_KEY}"
HMAC_SECRET="${TEXTCONVO_HMAC_SECRET:?Set TEXTCONVO_HMAC_SECRET — ask support to enable signing}"

PHONE="${1:-+15035551234}"
REQUEST_ID="$(uuidgen)"
TIMESTAMP="$(date +%s)"

# Serialise the body ONCE. This exact string is both signed and sent.
RAW_BODY="{\"phone\":\"$PHONE\",\"first_name\":\"Jane\",\"last_name\":\"Doe\"}"

# timestamp + "." + rawBody, keyed with the shared secret, hex encoded.
SIGNATURE="$(printf '%s' "$TIMESTAMP.$RAW_BODY" \
  | openssl dgst -sha256 -hmac "$HMAC_SECRET" \
  | sed 's/^.* //')"

echo "Signing:  $TIMESTAMP.<body>"
echo "Signature: $SIGNATURE"

curl -sS -X POST "$BASE_URL/functions/v1/ingest-lead" \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $API_KEY" \
  -H "X-Source-Key: $SOURCE_KEY" \
  -H "X-Request-Id: $REQUEST_ID" \
  -H "X-TC-Timestamp: $TIMESTAMP" \
  -H "X-TC-Signature: $SIGNATURE" \
  -d "$RAW_BODY" \
  -w "\nHTTP %{http_code}\n"

# Troubleshooting
#   401 with a signature error — you signed a different string than you sent.
#     Print both and diff them. Pretty-printing the JSON after signing is the
#     usual culprit.
#   401 with a timestamp error — your clock has drifted. Sync NTP.
#   Signatures are compared case-insensitively, so upper or lower hex is fine.
