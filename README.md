<h1 align="center">TextConvo API Examples</h1>

<p align="center"><strong>Official, runnable examples for the TextConvo API in nine languages.</strong></p>

<p align="center">
  <a href="https://textconvo.ai">Website</a> &nbsp;&middot;&nbsp;
  <a href="https://textconvo.ai/docs">Developer Docs</a> &nbsp;&middot;&nbsp;
  <a href="https://textconvo.ai/docs#lead-ingestion-api">API Reference</a> &nbsp;&middot;&nbsp;
  <a href="https://textconvo.ai/blog">Blog</a> &nbsp;&middot;&nbsp;
  <a href="https://textconvo.ai/contact-us">Support</a>
</p>

<p align="center">
  <a href="https://textconvo.ai/docs"><img alt="Docs" src="https://img.shields.io/badge/docs-textconvo.ai%2Fdocs-1f6feb?style=flat-square"></a>
  <a href="LICENSE"><img alt="License" src="https://img.shields.io/badge/license-MIT-2ea043?style=flat-square"></a>
  <img alt="Languages" src="https://img.shields.io/badge/languages-9-8957e5?style=flat-square">
  <a href="https://github.com/textconvo/textconvo-api-examples/issues"><img alt="Issues" src="https://img.shields.io/github/issues/textconvo/textconvo-api-examples?style=flat-square"></a>
  <a href="https://github.com/textconvo/.github/blob/main/CONTRIBUTING.md"><img alt="PRs welcome" src="https://img.shields.io/badge/PRs-welcome-db6d28?style=flat-square"></a>
</p>

---

[TextConvo](https://textconvo.ai) is an AI orchestration platform for customer conversations across SMS, RCS, Voice AI, Email, and WhatsApp. You hand it a lead or an event; it runs the conversation and tells you what happened through webhooks.

This repository shows you how to talk to it. Every example is small, self-contained, and written to be copied into a real integration.

> **Reference documentation lives at [textconvo.ai/docs](https://textconvo.ai/docs).** This repository does not duplicate it. If an example and the docs ever disagree, the docs are right &mdash; and we would like a [bug report](https://github.com/textconvo/textconvo-api-examples/issues/new/choose).

## Languages

| Language | Path | Runtime used |
| --- | --- | --- |
| cURL / shell | [examples/curl](examples/curl) | bash, curl, openssl |
| JavaScript | [examples/javascript](examples/javascript) | Browser-free, fetch |
| TypeScript | [examples/typescript](examples/typescript) | TypeScript 5+ |
| Node.js | [examples/node](examples/node) | Node 18+ |
| Python | [examples/python](examples/python) | Python 3.9+ |
| Go | [examples/go](examples/go) | Go 1.21+ |
| Java | [examples/java](examples/java) | Java 17+ |
| C# | [examples/csharp](examples/csharp) | .NET 8+ |
| PHP | [examples/php](examples/php) | PHP 8.1+ |

## What each example demonstrates

1. **Authentication** &mdash; the three required headers, plus optional HMAC request signing.
2. **Lead ingestion** &mdash; creating a lead so TextConvo can start a journey.
3. **Idempotency** &mdash; using a request id so a retry never double-ingests.
4. **Error handling** &mdash; reading the error code, not just the status line.
5. **Rate limits** &mdash; respecting 429 and the retry hint that comes with it.
6. **Retry logic** &mdash; exponential backoff with jitter, only for retryable failures.
7. **Webhook receipt** &mdash; verifying a signature before trusting a payload.

## Operation coverage

The public API surface today covers lead ingestion and event webhooks. Everything else &mdash; the SMS, RCS, Voice AI, Email, and WhatsApp sends themselves &mdash; is orchestrated by the platform once a lead enters a journey, and direct API access is on the roadmap.

| Operation | Status | Where |
| --- | --- | --- |
| Authentication | Available | [examples](examples) &middot; [docs](https://textconvo.ai/docs#authentication) |
| HMAC request signing | Available | [examples](examples) &middot; [docs](https://textconvo.ai/docs#hmac-authentication) |
| Ingest lead / trigger journey | Available | [examples](examples) &middot; [docs](https://textconvo.ai/docs#lead-ingestion-api) |
| Receive webhooks | Available | [textconvo-webhooks](https://github.com/textconvo/textconvo-webhooks) |
| Error handling | Available | [examples](examples) &middot; [docs](https://textconvo.ai/docs#error-codes) |
| Rate limiting and retries | Available | [examples](examples) &middot; [docs](https://textconvo.ai/docs#rate-limits) |
| Send SMS directly | Platform-orchestrated | [docs](https://textconvo.ai/product/sms) |
| Send Email directly | Platform-orchestrated | [docs](https://textconvo.ai/product/email) |
| Send WhatsApp directly | Platform-orchestrated | [docs](https://textconvo.ai/product/whatsapp) |
| Retrieve contact | Roadmap | [COVERAGE.md](docs/COVERAGE.md) |
| Get message status | Roadmap &mdash; use webhooks today | [COVERAGE.md](docs/COVERAGE.md) |
| Pagination | Roadmap &mdash; arrives with the first list endpoint | [COVERAGE.md](docs/COVERAGE.md) |

Full detail, including what to use in the meantime, is in [docs/COVERAGE.md](docs/COVERAGE.md).

## Setup

You need a TextConvo account with API access, an API key, and a source key. [Contact us](https://textconvo.ai/contact-us) if you do not have them yet.

Copy the sample environment file and fill it in:

```bash
cp .env.example .env
```

Every example reads configuration from the environment. Nothing in this repository contains a real credential, and nothing you add should be committed.

| Variable | Required | Purpose |
| --- | --- | --- |
| TEXTCONVO_API_KEY | Yes | Your API key |
| TEXTCONVO_SOURCE_KEY | Yes | Identifies the lead source |
| TEXTCONVO_HMAC_SECRET | Only with HMAC enabled | Signs outbound requests |
| TEXTCONVO_WEBHOOK_SECRET | For receivers | Verifies inbound webhooks |
| TEXTCONVO_BASE_URL | No | Defaults to https://api.textconvo.ai |

## Sixty-second start

```bash
curl -X POST "https://api.textconvo.ai/functions/v1/ingest-lead" \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $TEXTCONVO_API_KEY" \
  -H "X-Source-Key: $TEXTCONVO_SOURCE_KEY" \
  -H "X-Request-Id: $(uuidgen)" \
  -d '{"phone":"+15035551234","first_name":"Jane","last_name":"Doe"}'
```

A 202 with an ingestion request id means the lead is queued and the journey will start. See [Quick start](https://textconvo.ai/docs#quick-start) for the annotated version.

## Best practices

**Send a unique request id on every call.** It is the idempotency key. Retry with the same id after a timeout and you get the original result back with a duplicate flag instead of a second lead.

**Retry only what is worth retrying.** Network failures, 429, and 5xx responses deserve exponential backoff with jitter. A 400 or 401 will fail identically forever &mdash; fix the request instead.

**Respect the rate limits.** Defaults are 60 requests per minute and 10 per second, per key. When you see a 429, honour the retry hint rather than hammering the endpoint.

**Put phone numbers in E.164 format.** `+15035551234`, not `(503) 555-1234`. It is the only genuinely required field, so get it right.

**Nest anything non-standard under custom_fields.** Top-level unknown fields are rejected by the field whitelist. Keep metadata and custom fields under the documented 2KB each.

**Verify webhook signatures with a constant-time comparison, and reject stale timestamps.** An unverified webhook is an open door.

**Keep secrets in a secret manager.** Never in source control, never in client-side code, never in a URL. Rotate on a schedule and use a distinct key per integration.

**Log the request id.** When you open a support ticket, that id is what lets us find your traffic quickly.

## Related repositories

| Repository | What it gives you |
| --- | --- |
| [textconvo-openapi](https://github.com/textconvo/textconvo-openapi) | Machine-readable specification for client generation |
| [textconvo-postman](https://github.com/textconvo/textconvo-postman) | Click-through collection for exploring the API |
| [textconvo-webhooks](https://github.com/textconvo/textconvo-webhooks) | Payloads, signature verification, and sample receivers |
| [textconvo-sample-apps](https://github.com/textconvo/textconvo-sample-apps) | Full demo applications |
| [awesome-textconvo](https://github.com/textconvo/awesome-textconvo) | Community tutorials and projects |

## See it live

Submit the [contact form](https://textconvo.ai/contact-us) and you get a direct line to **Ria**, the TextConvo AI orchestrator &mdash; call her for a live voice demo, or text her and watch the SMS AI reply in real time. A human follows up within one business day, and the same form is how API credentials, a source key, and a webhook secret are issued.

Handed a TextConvo QR code at an event or in a demo? Scanning it opens the same conversation. The form is simply the path that works for everyone.

## Contributing

We would love a better example than ours. Read [CONTRIBUTING.md](https://github.com/textconvo/.github/blob/main/CONTRIBUTING.md), then open an issue or a pull request. Good first contributions: a framework variant, a clearer error message, a missing runtime version.

## Security

Never open a public issue for a vulnerability &mdash; follow [SECURITY.md](https://github.com/textconvo/.github/blob/main/SECURITY.md). If you spot a committed credential anywhere in this account, tell us the same way.

## License

[MIT](LICENSE) &copy; TextConvo. Use these examples in your own code freely.
