<?php

declare(strict_types=1);

/**
 * TextConvo — PHP example
 *
 * Authentication, optional HMAC signing, idempotency, error handling,
 * rate-limit awareness, and retry with exponential backoff and jitter.
 *
 * Docs: https://textconvo.ai/docs
 * Requires: PHP 8.1+ with the curl and json extensions
 *
 * Run:
 *   TEXTCONVO_API_KEY=... TEXTCONVO_SOURCE_KEY=... php ingest-lead.php
 */

final class TextConvoException extends RuntimeException
{
    public function __construct(
        public readonly int $status,
        public readonly string $code,
        string $message,
        public readonly string $requestId,
        public readonly ?int $retryAfter = null,
    ) {
        parent::__construct(sprintf('[%d %s] %s', $status, $code, $message));
    }

    /** 429 and 5xx are worth another attempt; 4xx is not. */
    public function isRetryable(): bool
    {
        return $this->status === 429 || $this->status >= 500;
    }
}

final class TextConvoClient
{
    private const INGEST_PATH = '/functions/v1/ingest-lead';

    public function __construct(
        private readonly string $apiKey,
        private readonly string $sourceKey,
        private readonly string $baseUrl = 'https://api.textconvo.ai',
        private readonly ?string $hmacSecret = null,
        private readonly int $timeoutSeconds = 10,
    ) {
    }

    /**
     * Ingest a lead.
     *
     * @param array<string, mixed> $lead  Only 'phone' is required, in E.164 format.
     * @param string $requestId           Idempotency key. Reuse it when retrying.
     * @return array<string, mixed>
     */
    public function ingestLead(array $lead, string $requestId): array
    {
        // Encode once: the exact string we sign is the exact string we send.
        $rawBody = json_encode($lead, JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES);

        $headers = [
            'Content-Type: application/json',
            'X-API-Key: ' . $this->apiKey,
            'X-Source-Key: ' . $this->sourceKey,
            'X-Request-Id: ' . $requestId,
        ];

        // Optional per-source signing: hex(HMAC_SHA256(secret, timestamp . '.' . rawBody)).
        // The timestamp must be within 300 seconds of server time.
        if ($this->hmacSecret !== null && $this->hmacSecret !== '') {
            $timestamp = (string) time();
            $signature = hash_hmac('sha256', $timestamp . '.' . $rawBody, $this->hmacSecret);
            $headers[] = 'X-TC-Timestamp: ' . $timestamp;
            $headers[] = 'X-TC-Signature: ' . $signature;
        }

        $curl = curl_init($this->baseUrl . self::INGEST_PATH);
        curl_setopt_array($curl, [
            CURLOPT_POST           => true,
            CURLOPT_POSTFIELDS     => $rawBody,
            CURLOPT_HTTPHEADER     => $headers,
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT        => $this->timeoutSeconds,
        ]);

        $responseBody = curl_exec($curl);
        $status = (int) curl_getinfo($curl, CURLINFO_RESPONSE_CODE);
        $curlError = curl_error($curl);
        curl_close($curl);

        if ($responseBody === false) {
            // Connection-level failure: retryable.
            throw new TextConvoException(503, 'NETWORK_ERROR', $curlError, $requestId);
        }

        $payload = json_decode((string) $responseBody, true) ?: [];

        if ($status === 202 && ($payload['success'] ?? false) === true) {
            $payload['request_id'] = $requestId;
            return $payload;
        }

        throw new TextConvoException(
            $status,
            $payload['code'] ?? ($status === 429 ? 'RATE_LIMITED' : 'REQUEST_ERROR'),
            $payload['error'] ?? sprintf('Unexpected status %d', $status),
            $requestId,
            isset($payload['retry_after']) ? (int) $payload['retry_after'] : null,
        );
    }

    /**
     * @param array<string, mixed> $lead
     * @return array<string, mixed>
     */
    public function ingestLeadWithRetry(array $lead, int $maxAttempts = 4): array
    {
        $requestId = self::uuidV4(); // stable across attempts, on purpose
        $lastException = null;

        for ($attempt = 0; $attempt < $maxAttempts; $attempt++) {
            try {
                return $this->ingestLead($lead, $requestId);
            } catch (TextConvoException $exception) {
                if (!$exception->isRetryable()) {
                    throw $exception;
                }

                $lastException = $exception;

                if ($attempt === $maxAttempts - 1) {
                    break;
                }

                // Prefer the server hint, otherwise exponential backoff with full jitter.
                $capped = min(2 ** $attempt, 30);
                $waitSeconds = $exception->retryAfter ?? random_int(0, (int) $capped);
                fwrite(STDERR, sprintf("Retrying in %ds after %s\n", $waitSeconds, $exception->getMessage()));
                sleep(max(1, $waitSeconds));
            }
        }

        throw $lastException;
    }

    private static function uuidV4(): string
    {
        $data = random_bytes(16);
        $data[6] = chr(ord($data[6]) & 0x0f | 0x40);
        $data[8] = chr(ord($data[8]) & 0x3f | 0x80);

        return vsprintf('%s%s-%s-%s-%s-%s%s%s', str_split(bin2hex($data), 4));
    }
}

// --- Usage -----------------------------------------------------------------

$apiKey = getenv('TEXTCONVO_API_KEY') ?: '';
$sourceKey = getenv('TEXTCONVO_SOURCE_KEY') ?: '';

if ($apiKey === '' || $sourceKey === '') {
    fwrite(STDERR, "Set TEXTCONVO_API_KEY and TEXTCONVO_SOURCE_KEY. See .env.example\n");
    exit(1);
}

$client = new TextConvoClient(
    apiKey: $apiKey,
    sourceKey: $sourceKey,
    baseUrl: getenv('TEXTCONVO_BASE_URL') ?: 'https://api.textconvo.ai',
    hmacSecret: getenv('TEXTCONVO_HMAC_SECRET') ?: null,
);

// phone is the only required field. Anything non-standard belongs in
// custom_fields — unknown top-level fields are rejected by the whitelist.
$lead = [
    'phone'         => getenv('TEST_PHONE') ?: '+15035551234',
    'first_name'    => 'Jane',
    'last_name'     => 'Doe',
    'email'         => 'jane.doe@example.com',
    'external_id'   => 'crm_00042',
    'city'          => 'Portland',
    'state'         => 'OR',
    'metadata'      => ['campaign' => 'spring-promo'],
    'custom_fields' => ['roof_age_years' => '12'],
];

try {
    $result = $client->ingestLeadWithRetry($lead);
} catch (TextConvoException $exception) {
    fwrite(STDERR, 'Failed: ' . $exception->getMessage() . PHP_EOL);
    fwrite(STDERR, 'Quote this request id to support: ' . $exception->requestId . PHP_EOL);
    fwrite(STDERR, 'Error codes: https://textconvo.ai/docs#error-codes' . PHP_EOL);
    exit(1);
}

echo json_encode($result, JSON_PRETTY_PRINT) . PHP_EOL;

if ($result['duplicate'] ?? false) {
    echo 'Already ingested under this request id — idempotency did its job.' . PHP_EOL;
}

echo 'Progress arrives by webhook: https://textconvo.ai/docs#webhooks' . PHP_EOL;
