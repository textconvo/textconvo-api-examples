"""TextConvo — Python example.

Authentication, optional HMAC signing, idempotency, error handling,
rate-limit awareness, and retry with exponential backoff and jitter.

Docs: https://textconvo.ai/docs
Requires: Python 3.9+ and requests  (pip install requests)

Run:
    export TEXTCONVO_API_KEY=... TEXTCONVO_SOURCE_KEY=...
    python ingest_lead.py
"""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import random
import sys
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Dict, Optional

import requests

BASE_URL = os.environ.get("TEXTCONVO_BASE_URL", "https://api.textconvo.ai")
INGEST_PATH = "/functions/v1/ingest-lead"

RETRYABLE_STATUSES = {429, 500, 502, 503, 504}


class TextConvoError(Exception):
    """A request failed. Inspect .status and .code before deciding what to do."""

    def __init__(
        self,
        status: int,
        code: str,
        message: str,
        request_id: str,
        retry_after: Optional[float] = None,
    ) -> None:
        super().__init__(f"[{status} {code}] {message}")
        self.status = status
        self.code = code
        self.request_id = request_id
        self.retry_after = retry_after

    @property
    def retryable(self) -> bool:
        return self.status in RETRYABLE_STATUSES


@dataclass
class TextConvoClient:
    """Minimal client for the lead ingestion endpoint."""

    api_key: str
    source_key: str
    base_url: str = BASE_URL
    hmac_secret: Optional[str] = None
    timeout: float = 10.0
    session: requests.Session = field(default_factory=requests.Session)

    def ingest_lead(self, lead: Dict[str, Any], request_id: Optional[str] = None) -> Dict[str, Any]:
        """Ingest a single lead.

        request_id is the idempotency key. Keep it stable across retries of the
        same logical lead and a network timeout can never create a duplicate.
        """
        request_id = request_id or str(uuid.uuid4())

        # Serialise once. The exact bytes we sign are the exact bytes we send.
        raw_body = json.dumps(lead, separators=(",", ":"))

        headers = {
            "Content-Type": "application/json",
            "X-API-Key": self.api_key,
            "X-Source-Key": self.source_key,
            "X-Request-Id": request_id,
        }

        # Optional per-source signing:
        #   hex(HMAC_SHA256(secret, timestamp + "." + raw_body))
        # The timestamp must be within 300 seconds of server time.
        if self.hmac_secret:
            timestamp = str(int(time.time()))
            signature = hmac.new(
                self.hmac_secret.encode("utf-8"),
                f"{timestamp}.{raw_body}".encode("utf-8"),
                hashlib.sha256,
            ).hexdigest()
            headers["X-TC-Timestamp"] = timestamp
            headers["X-TC-Signature"] = signature

        try:
            response = self.session.post(
                self.base_url + INGEST_PATH,
                data=raw_body,
                headers=headers,
                timeout=self.timeout,
            )
        except requests.RequestException as exc:  # DNS, connection, read timeout
            raise TextConvoError(503, "NETWORK_ERROR", str(exc), request_id) from exc

        try:
            payload = response.json()
        except ValueError:
            payload = {}

        if response.status_code == 202 and payload.get("success"):
            payload["request_id"] = request_id
            return payload

        retry_after = payload.get("retry_after")
        if retry_after is None and "Retry-After" in response.headers:
            try:
                retry_after = float(response.headers["Retry-After"])
            except ValueError:
                retry_after = None

        raise TextConvoError(
            response.status_code,
            payload.get("code") or ("RATE_LIMITED" if response.status_code == 429 else "REQUEST_ERROR"),
            payload.get("error") or f"Unexpected status {response.status_code}",
            request_id,
            retry_after,
        )

    def ingest_lead_with_retry(self, lead: Dict[str, Any], max_attempts: int = 4) -> Dict[str, Any]:
        """Retry only what is worth retrying: 429, 5xx, and network failures.

        A 400 or 401 fails identically forever — fix the request instead.
        """
        request_id = str(uuid.uuid4())  # stable across attempts on purpose
        last_error: Optional[TextConvoError] = None

        for attempt in range(max_attempts):
            try:
                return self.ingest_lead(lead, request_id=request_id)
            except TextConvoError as exc:
                if not exc.retryable:
                    raise
                last_error = exc
                if attempt == max_attempts - 1:
                    break
                # Honour the server hint when there is one, otherwise back off
                # exponentially with full jitter so clients do not synchronise.
                wait = exc.retry_after or random.uniform(0, min(2 ** attempt, 30))
                print(f"Retrying in {wait:.1f}s after {exc}", file=sys.stderr)
                time.sleep(wait)

        assert last_error is not None
        raise last_error


def main() -> int:
    api_key = os.environ.get("TEXTCONVO_API_KEY")
    source_key = os.environ.get("TEXTCONVO_SOURCE_KEY")

    if not api_key or not source_key:
        print("Set TEXTCONVO_API_KEY and TEXTCONVO_SOURCE_KEY. See .env.example", file=sys.stderr)
        return 1

    client = TextConvoClient(
        api_key=api_key,
        source_key=source_key,
        hmac_secret=os.environ.get("TEXTCONVO_HMAC_SECRET") or None,
    )

    # phone is the only required field, in E.164 format. Anything
    # non-standard belongs under custom_fields, never at the top level.
    lead = {
        "phone": os.environ.get("TEST_PHONE", "+15035551234"),
        "first_name": "Jane",
        "last_name": "Doe",
        "email": "jane.doe@example.com",
        "external_id": "crm_00042",
        "city": "Portland",
        "state": "OR",
        "metadata": {"campaign": "spring-promo"},
        "custom_fields": {"roof_age_years": "12"},
    }

    try:
        result = client.ingest_lead_with_retry(lead)
    except TextConvoError as exc:
        print(f"Failed: {exc}", file=sys.stderr)
        print(f"Quote this request id to support: {exc.request_id}", file=sys.stderr)
        return 1

    print(json.dumps(result, indent=2))
    if result.get("duplicate"):
        print("Already ingested under this request id — idempotency did its job.")
    print("Progress arrives by webhook: https://textconvo.ai/docs#webhooks")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
