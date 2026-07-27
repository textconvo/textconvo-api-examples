// TextConvo — C# / .NET example
//
// Authentication, optional HMAC signing, idempotency, error handling,
// rate-limit awareness, and retry with exponential backoff and jitter.
//
// Docs: https://textconvo.ai/docs
// Requires: .NET 8+
//
// Run:
//   dotnet new console -o textconvo-example && cp Program.cs textconvo-example/
//   cd textconvo-example
//   TEXTCONVO_API_KEY=... TEXTCONVO_SOURCE_KEY=... dotnet run

using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

var apiKey = Environment.GetEnvironmentVariable("TEXTCONVO_API_KEY");
var sourceKey = Environment.GetEnvironmentVariable("TEXTCONVO_SOURCE_KEY");

if (string.IsNullOrWhiteSpace(apiKey) || string.IsNullOrWhiteSpace(sourceKey))
{
    Console.Error.WriteLine("Set TEXTCONVO_API_KEY and TEXTCONVO_SOURCE_KEY. See .env.example");
    return 1;
}

var client = new TextConvoClient(
    apiKey: apiKey,
    sourceKey: sourceKey,
    baseUrl: Environment.GetEnvironmentVariable("TEXTCONVO_BASE_URL") ?? "https://api.textconvo.ai",
    hmacSecret: Environment.GetEnvironmentVariable("TEXTCONVO_HMAC_SECRET"));

// phone is the only required field, in E.164 format. Anything non-standard
// belongs under custom_fields — unknown top-level fields are rejected.
var lead = new Lead
{
    Phone = Environment.GetEnvironmentVariable("TEST_PHONE") ?? "+15035551234",
    FirstName = "Jane",
    LastName = "Doe",
    Email = "jane.doe@example.com",
    ExternalId = "crm_00042",
    City = "Portland",
    State = "OR",
    Metadata = new Dictionary<string, object> { ["campaign"] = "spring-promo" },
    CustomFields = new Dictionary<string, object> { ["roof_age_years"] = "12" }
};

try
{
    var accepted = await client.IngestLeadWithRetryAsync(lead);
    Console.WriteLine($"Accepted: {accepted.IngestionRequestId}");
    if (accepted.Duplicate)
    {
        Console.WriteLine("Already ingested under this request id — idempotency did its job.");
    }
    Console.WriteLine("Progress arrives by webhook: https://textconvo.ai/docs#webhooks");
    return 0;
}
catch (TextConvoException exception)
{
    Console.Error.WriteLine($"Failed: {exception.Message}");
    Console.Error.WriteLine($"Quote this request id to support: {exception.RequestId}");
    Console.Error.WriteLine("Error codes: https://textconvo.ai/docs#error-codes");
    return 1;
}

// --- Types -----------------------------------------------------------------

sealed class Lead
{
    [JsonPropertyName("phone")] public required string Phone { get; init; }
    [JsonPropertyName("email")] public string? Email { get; init; }
    [JsonPropertyName("external_id")] public string? ExternalId { get; init; }
    [JsonPropertyName("first_name")] public string? FirstName { get; init; }
    [JsonPropertyName("last_name")] public string? LastName { get; init; }
    [JsonPropertyName("city")] public string? City { get; init; }
    [JsonPropertyName("state")] public string? State { get; init; }
    [JsonPropertyName("zip")] public string? Zip { get; init; }
    [JsonPropertyName("metadata")] public Dictionary<string, object>? Metadata { get; init; }
    [JsonPropertyName("custom_fields")] public Dictionary<string, object>? CustomFields { get; init; }
}

sealed class IngestResponse
{
    [JsonPropertyName("success")] public bool Success { get; init; }
    [JsonPropertyName("ingestion_request_id")] public string IngestionRequestId { get; init; } = "";
    [JsonPropertyName("duplicate")] public bool Duplicate { get; init; }
    [JsonPropertyName("error")] public string? Error { get; init; }
    [JsonPropertyName("code")] public string? Code { get; init; }
    [JsonPropertyName("retry_after")] public int? RetryAfter { get; init; }
}

sealed class TextConvoException(HttpStatusCode status, string code, string message, string requestId, int? retryAfterSeconds = null)
    : Exception($"[{(int)status} {code}] {message}")
{
    public HttpStatusCode Status { get; } = status;
    public string Code { get; } = code;
    public string RequestId { get; } = requestId;
    public int? RetryAfterSeconds { get; } = retryAfterSeconds;

    // 429 and 5xx deserve another attempt. 4xx will fail identically forever.
    public bool IsRetryable => Status == HttpStatusCode.TooManyRequests || (int)Status >= 500;
}

sealed class TextConvoClient(string apiKey, string sourceKey, string baseUrl, string? hmacSecret = null)
{
    private const string IngestPath = "/functions/v1/ingest-lead";

    private static readonly HttpClient Http = new() { Timeout = TimeSpan.FromSeconds(10) };

    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull
    };

    /// <summary>Ingest a lead. requestId is the idempotency key — reuse it when retrying.</summary>
    public async Task<IngestResponse> IngestLeadAsync(Lead lead, string requestId, CancellationToken cancellationToken = default)
    {
        // Serialise once: the exact string we sign is the exact string we send.
        var rawBody = JsonSerializer.Serialize(lead, JsonOptions);

        using var request = new HttpRequestMessage(HttpMethod.Post, baseUrl + IngestPath)
        {
            Content = new StringContent(rawBody, Encoding.UTF8, "application/json")
        };

        request.Headers.Add("X-API-Key", apiKey);
        request.Headers.Add("X-Source-Key", sourceKey);
        request.Headers.Add("X-Request-Id", requestId);

        // Optional per-source signing: hex(HMAC_SHA256(secret, timestamp + "." + rawBody)).
        // The timestamp must be within 300 seconds of server time.
        if (!string.IsNullOrWhiteSpace(hmacSecret))
        {
            var timestamp = DateTimeOffset.UtcNow.ToUnixTimeSeconds().ToString();
            using var hmac = new HMACSHA256(Encoding.UTF8.GetBytes(hmacSecret));
            var signature = Convert.ToHexString(hmac.ComputeHash(Encoding.UTF8.GetBytes(timestamp + "." + rawBody))).ToLowerInvariant();
            request.Headers.Add("X-TC-Timestamp", timestamp);
            request.Headers.Add("X-TC-Signature", signature);
        }

        HttpResponseMessage response;
        try
        {
            response = await Http.SendAsync(request, cancellationToken);
        }
        catch (Exception exception) when (exception is HttpRequestException or TaskCanceledException)
        {
            // Transport failure: retryable.
            throw new TextConvoException(HttpStatusCode.ServiceUnavailable, "NETWORK_ERROR", exception.Message, requestId);
        }

        var body = await response.Content.ReadAsStringAsync(cancellationToken);
        var payload = string.IsNullOrWhiteSpace(body) ? null : JsonSerializer.Deserialize<IngestResponse>(body);

        if (response.StatusCode == HttpStatusCode.Accepted && payload is { Success: true })
        {
            return payload;
        }

        var code = payload?.Code ?? (response.StatusCode == HttpStatusCode.TooManyRequests ? "RATE_LIMITED" : "REQUEST_ERROR");
        var message = payload?.Error ?? $"Unexpected status {(int)response.StatusCode}";
        var retryAfter = payload?.RetryAfter ?? (int?)response.Headers.RetryAfter?.Delta?.TotalSeconds;

        throw new TextConvoException(response.StatusCode, code, message, requestId, retryAfter);
    }

    /// <summary>Retries 429, 5xx, and transport failures with exponential backoff and full jitter.</summary>
    public async Task<IngestResponse> IngestLeadWithRetryAsync(Lead lead, int maxAttempts = 4, CancellationToken cancellationToken = default)
    {
        var requestId = Guid.NewGuid().ToString(); // stable across attempts, on purpose
        TextConvoException? last = null;

        for (var attempt = 0; attempt < maxAttempts; attempt++)
        {
            if (attempt > 0)
            {
                var capped = Math.Min(Math.Pow(2, attempt), 30);
                var seconds = last?.RetryAfterSeconds ?? Random.Shared.Next(1, (int)capped + 1);
                Console.Error.WriteLine($"Retry {attempt} in {seconds}s");
                await Task.Delay(TimeSpan.FromSeconds(seconds), cancellationToken);
            }

            try
            {
                return await IngestLeadAsync(lead, requestId, cancellationToken);
            }
            catch (TextConvoException exception) when (exception.IsRetryable)
            {
                last = exception;
            }
        }

        throw last!;
    }
}
