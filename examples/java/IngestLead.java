/*
 * TextConvo — Java example
 *
 * Authentication, optional HMAC signing, idempotency, error handling,
 * rate-limit awareness, and retry with exponential backoff and jitter.
 *
 * Docs: https://textconvo.ai/docs
 * Requires: Java 17+ (java.net.http, HexFormat). No third-party dependencies;
 *           the JSON here is built by hand to keep the example dependency-free.
 *           In production use Jackson or Gson.
 *
 * Run:
 *   export TEXTCONVO_API_KEY=... TEXTCONVO_SOURCE_KEY=...
 *   java IngestLead.java
 */

import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.time.Instant;
import java.util.HexFormat;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.ThreadLocalRandom;

public final class IngestLead {

    private static final String INGEST_PATH = "/functions/v1/ingest-lead";

    /** Thrown for any non-202 response. Check status before deciding to retry. */
    static final class TextConvoException extends RuntimeException {
        final int status;
        final String code;
        final String requestId;
        final Optional<Integer> retryAfterSeconds;

        TextConvoException(int status, String code, String message, String requestId, Optional<Integer> retryAfterSeconds) {
            super("[" + status + " " + code + "] " + message);
            this.status = status;
            this.code = code;
            this.requestId = requestId;
            this.retryAfterSeconds = retryAfterSeconds;
        }

        boolean isRetryable() {
            return status == 429 || status >= 500;
        }
    }

    private final HttpClient http = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(10))
            .build();

    private final String baseUrl;
    private final String apiKey;
    private final String sourceKey;
    private final String hmacSecret;

    IngestLead(String baseUrl, String apiKey, String sourceKey, String hmacSecret) {
        this.baseUrl = baseUrl;
        this.apiKey = apiKey;
        this.sourceKey = sourceKey;
        this.hmacSecret = hmacSecret;
    }

    /**
     * Ingest a lead.
     *
     * @param rawBody   the exact JSON string to send — serialise once, sign and send the same bytes
     * @param requestId idempotency key; reuse it across retries of the same logical lead
     */
    String ingestLead(String rawBody, String requestId) throws Exception {
        HttpRequest.Builder builder = HttpRequest.newBuilder()
                .uri(URI.create(baseUrl + INGEST_PATH))
                .timeout(Duration.ofSeconds(10))
                .header("Content-Type", "application/json")
                .header("X-API-Key", apiKey)
                .header("X-Source-Key", sourceKey)
                .header("X-Request-Id", requestId)
                .POST(HttpRequest.BodyPublishers.ofString(rawBody, StandardCharsets.UTF_8));

        // Optional per-source signing: hex(HMAC_SHA256(secret, timestamp + "." + rawBody)).
        // The timestamp must be within 300 seconds of server time.
        if (hmacSecret != null && !hmacSecret.isBlank()) {
            String timestamp = Long.toString(Instant.now().getEpochSecond());
            builder.header("X-TC-Timestamp", timestamp)
                   .header("X-TC-Signature", sign(timestamp + "." + rawBody, hmacSecret));
        }

        HttpResponse<String> response = http.send(builder.build(), HttpResponse.BodyHandlers.ofString());
        String body = response.body();

        if (response.statusCode() == 202 && body.contains("\"success\":true")) {
            return body;
        }

        String code = extract(body, "code").orElse(response.statusCode() == 429 ? "RATE_LIMITED" : "REQUEST_ERROR");
        String message = extract(body, "error").orElse("Unexpected status " + response.statusCode());
        Optional<Integer> retryAfter = response.headers().firstValue("retry-after").map(Integer::parseInt);

        throw new TextConvoException(response.statusCode(), code, message, requestId, retryAfter);
    }

    /** Retries 429, 5xx, and transport failures. A 400 or 401 is surfaced immediately. */
    String ingestLeadWithRetry(String rawBody, int maxAttempts) throws Exception {
        String requestId = UUID.randomUUID().toString(); // stable across attempts, on purpose
        TextConvoException last = null;

        for (int attempt = 0; attempt < maxAttempts; attempt++) {
            if (attempt > 0) {
                long waitMillis = last != null && last.retryAfterSeconds.isPresent()
                        ? last.retryAfterSeconds.get() * 1000L
                        : ThreadLocalRandom.current().nextLong(1, Math.min(1L << attempt, 30) * 1000L);
                System.err.println("Retry " + attempt + " in " + waitMillis + "ms");
                Thread.sleep(waitMillis);
            }

            try {
                return ingestLead(rawBody, requestId);
            } catch (TextConvoException exception) {
                if (!exception.isRetryable()) {
                    throw exception;
                }
                last = exception;
            }
        }

        throw last;
    }

    private static String sign(String data, String secret) throws Exception {
        Mac mac = Mac.getInstance("HmacSHA256");
        mac.init(new SecretKeySpec(secret.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
        return HexFormat.of().formatHex(mac.doFinal(data.getBytes(StandardCharsets.UTF_8)));
    }

    /** Tiny value reader so the example stays dependency-free. Use a real JSON library. */
    private static Optional<String> extract(String json, String key) {
        String needle = "\"" + key + "\":\"";
        int start = json.indexOf(needle);
        if (start < 0) {
            return Optional.empty();
        }
        start += needle.length();
        int end = json.indexOf('"', start);
        return end < 0 ? Optional.empty() : Optional.of(json.substring(start, end));
    }

    public static void main(String[] args) throws Exception {
        Map<String, String> env = System.getenv();
        String apiKey = env.get("TEXTCONVO_API_KEY");
        String sourceKey = env.get("TEXTCONVO_SOURCE_KEY");

        if (apiKey == null || sourceKey == null) {
            System.err.println("Set TEXTCONVO_API_KEY and TEXTCONVO_SOURCE_KEY. See .env.example");
            System.exit(1);
        }

        String phone = env.getOrDefault("TEST_PHONE", "+15035551234");

        // phone is the only required field, in E.164 format. Anything non-standard
        // belongs under custom_fields — unknown top-level fields are rejected.
        String rawBody = """
                {
                  "phone": "%s",
                  "first_name": "Jane",
                  "last_name": "Doe",
                  "email": "jane.doe@example.com",
                  "external_id": "crm_00042",
                  "city": "Portland",
                  "state": "OR",
                  "metadata": { "campaign": "spring-promo" },
                  "custom_fields": { "roof_age_years": "12" }
                }""".formatted(phone);

        IngestLead client = new IngestLead(
                env.getOrDefault("TEXTCONVO_BASE_URL", "https://api.textconvo.ai"),
                apiKey,
                sourceKey,
                env.get("TEXTCONVO_HMAC_SECRET"));

        try {
            System.out.println(client.ingestLeadWithRetry(rawBody, 4));
            System.out.println("Progress arrives by webhook: https://textconvo.ai/docs#webhooks");
        } catch (TextConvoException exception) {
            System.err.println("Failed: " + exception.getMessage());
            System.err.println("Quote this request id to support: " + exception.requestId);
            System.err.println("Error codes: https://textconvo.ai/docs#error-codes");
            System.exit(1);
        }
    }
}
