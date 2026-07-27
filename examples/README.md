# Examples

One folder per language. Every file is standalone: read it top to bottom and you have the whole picture.

| Language | File | Notes |
| --- | --- | --- |
| cURL | [curl/ingest-lead.sh](curl/ingest-lead.sh) | The annotated happy path, with status-by-status error handling |
| cURL | [curl/ingest-lead-hmac.sh](curl/ingest-lead-hmac.sh) | HMAC-SHA256 request signing with openssl |
| cURL | [curl/retry-with-backoff.sh](curl/retry-with-backoff.sh) | Backoff, jitter, and 429 handling in pure bash |
| JavaScript | [javascript/ingest-lead.js](javascript/ingest-lead.js) | Smallest possible fetch version |
| TypeScript | [typescript/ingestLead.ts](typescript/ingestLead.ts) | Typed client with a retry wrapper |
| Node.js | [node/ingest-lead.js](node/ingest-lead.js) | Error classes, HMAC, timeouts, retry |
| Python | [python/ingest_lead.py](python/ingest_lead.py) | Dataclass client, requests, retry |
| Go | [go/main.go](go/main.go) | Typed structs, context timeouts, retry |
| Java | [java/IngestLead.java](java/IngestLead.java) | java.net.http, no dependencies |
| C# | [csharp/Program.cs](csharp/Program.cs) | .NET 8, System.Text.Json, retry |
| PHP | [php/ingest-lead.php](php/ingest-lead.php) | curl extension, typed exception |

## The same seven ideas, in every language

1. **Three headers authenticate you:** X-API-Key, X-Source-Key, X-Request-Id. Missing any one fails the call.
2. **X-Request-Id is an idempotency key.** Generate it once per logical lead, reuse it on every retry.
3. **Serialise the body once.** If you sign a request, sign the exact string you send — re-encoding after signing is the most common HMAC failure.
4. **202 means queued,** not delivered. Delivery, replies, and opt-outs arrive by [webhook](https://textconvo.ai/docs#webhooks).
5. **Read the error code,** not just the status. The payload tells you which field was wrong.
6. **Retry only 429, 5xx, and network errors,** with exponential backoff and jitter. Never retry a 400 or 401.
7. **Keep secrets in the environment.** Nothing here reads a hardcoded key, and neither should your code.

## Running them

Copy the environment file at the repository root and fill it in:

```bash
cp ../.env.example ../.env
```

Then, from inside a language folder:

```bash
chmod +x curl/*.sh && ./curl/ingest-lead.sh     # cURL
node node/ingest-lead.js                        # Node 18+
python python/ingest_lead.py                    # Python 3.9+, pip install requests
go run go/main.go                               # Go 1.21+
java java/IngestLead.java                       # Java 17+
dotnet run                                      # .NET 8+, inside a console project
php php/ingest-lead.php                         # PHP 8.1+
```

Use a phone number you own. Never test against a real customer.

## Missing your language or framework?

[Open an issue](https://github.com/textconvo/textconvo-api-examples/issues/new/choose) or send a pull request — see [CONTRIBUTING.md](https://github.com/textconvo/.github/blob/main/CONTRIBUTING.md).
