# Coverage

What you can do through the public API today, what the platform handles for you, and what is coming. Written down so nobody has to guess from an empty folder.

The authoritative surface is always [textconvo.ai/docs](https://textconvo.ai/docs).

## Available now

| Capability | Endpoint or mechanism | Example |
| --- | --- | --- |
| Authentication | X-API-Key, X-Source-Key, X-Request-Id headers | every example |
| HMAC request signing | X-TC-Timestamp, X-TC-Signature | [curl/ingest-lead-hmac.sh](../examples/curl/ingest-lead-hmac.sh) |
| Ingest a lead and start a journey | POST /functions/v1/ingest-lead | [examples](../examples) |
| Idempotent retries | X-Request-Id as the idempotency key | [curl/retry-with-backoff.sh](../examples/curl/retry-with-backoff.sh) |
| Error handling | documented codes and payload shape | every example |
| Rate-limit handling | HTTP 429 with retry_after | [curl/retry-with-backoff.sh](../examples/curl/retry-with-backoff.sh) |
| Receive events | Signed webhooks | [textconvo-webhooks](https://github.com/textconvo/textconvo-webhooks) |
| CRM sync | HubSpot, GoHighLevel, Zoho, Pipedrive, Zendesk, Salesforce | [docs](https://textconvo.ai/docs#crm-integrations) |

## Handled by the platform, not by your code

TextConvo is an orchestration platform. Once a lead enters a journey, the platform decides what to send, on which channel, in what order, and when — with consent and suppression rules applied. That is the product doing its job, so there is no send-a-message call for you to make.

| You might expect | What actually happens | Where to configure it |
| --- | --- | --- |
| Send SMS | The journey sends it, then reports delivery by webhook | [SMS](https://textconvo.ai/product/sms) |
| Send RCS | Same, with channel selection handled for you | [RCS](https://textconvo.ai/product/rcs) |
| Place a voice call | Voice AI runs the conversation and reports the outcome | [Voice AI](https://textconvo.ai/product/voice-ai) |
| Send email | The journey sends it; lead.sent confirms | [Email](https://textconvo.ai/product/email) |
| Send WhatsApp | The journey sends it on the configured template | [WhatsApp](https://textconvo.ai/product/whatsapp) |
| Build a journey | Configured in the app, triggered by ingestion | [Platform](https://textconvo.ai/platform) |

Direct channel-send API access is on the roadmap. Until then, ingesting a lead is how you start a conversation.

## Roadmap

These have no public endpoint yet. The workaround column is what integrators use today.

| Capability | Status | Use in the meantime |
| --- | --- | --- |
| Retrieve a contact | Planned | Store the contact_id you receive on lead.accepted, and mirror state in your CRM |
| Get message status | Planned | Consume lead.delivered, lead.failed, lead.reply, lead.click, lead.opt_out webhooks |
| List and paginate resources | Planned; pagination conventions ship with the first list endpoint | Keep your own store keyed by external_id |
| Trigger a journey directly by id | Planned | Ingest the lead; the journey is queued from your account configuration |
| Programmatic template management | Planned | Manage templates in the app |

When these land, this repository gains matching examples in all nine languages and [textconvo-openapi](https://github.com/textconvo/textconvo-openapi) gains the schemas. Watch the repository or follow the [blog](https://textconvo.ai/blog) for release notes.

## Requesting something

If an operation you need is missing, [open a feature request](https://github.com/textconvo/textconvo-api-examples/issues/new/choose) describing the integration you are building. Concrete use cases move roadmap items faster than abstract ones.
