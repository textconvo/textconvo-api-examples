/**
 * TextConvo — JavaScript example (fetch, no dependencies)
 *
 * A deliberately small, framework-free version of the ingest call.
 * For production-grade retry and error classes, see ../node/ingest-lead.js
 *
 * Docs: https://textconvo.ai/docs#lead-ingestion-api
 *
 * IMPORTANT: never run this in a browser with a real API key. Keys belong on
 * a server. Call your own backend from the browser, and let the backend talk
 * to TextConvo.
 */

export async function ingestLead(lead, config) {
  const baseUrl = config.baseUrl || 'https://api.textconvo.ai';

  // The idempotency key. Reuse it when retrying the same logical lead.
  const requestId = config.requestId || crypto.randomUUID();

  const response = await fetch(baseUrl + '/functions/v1/ingest-lead', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': config.apiKey,
      'X-Source-Key': config.sourceKey,
      'X-Request-Id': requestId
    },
    body: JSON.stringify(lead)
  });

  const payload = await response.json().catch(() => ({}));

  if (response.status === 202) {
    // { success: true, ingestion_request_id: "..." }
    // A retry with the same request id also returns { duplicate: true }.
    return { ok: true, requestId: requestId, ...payload };
  }

  // Documented statuses: 400, 401, 403, 429, 500.
  // https://textconvo.ai/docs#error-codes
  return {
    ok: false,
    requestId: requestId,
    status: response.status,
    code: payload.code,
    error: payload.error || 'Request failed',
    retryAfter: payload.retry_after
  };
}

// --- Usage -----------------------------------------------------------------

const result = await ingestLead(
  {
    phone: '+15035551234',   // required, E.164
    first_name: 'Jane',
    last_name: 'Doe',
    email: 'jane.doe@example.com',
    custom_fields: { plan_interest: 'premium' }
  },
  {
    apiKey: process.env.TEXTCONVO_API_KEY,
    sourceKey: process.env.TEXTCONVO_SOURCE_KEY
  }
);

if (result.ok) {
  console.log('Queued:', result.ingestion_request_id);
} else if (result.status === 429) {
  console.warn('Rate limited. Wait ' + result.retryAfter + 's, then retry with the same request id.');
} else {
  console.error('Failed [' + result.status + ' ' + result.code + ']: ' + result.error);
}
