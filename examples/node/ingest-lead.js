/**
 * TextConvo — Node.js example
 *
 * Demonstrates authentication, optional HMAC signing, idempotency,
 * error handling, rate-limit awareness, and retry with backoff.
 *
 * Docs: https://textconvo.ai/docs
 * Requires: Node 18+ (global fetch and crypto.randomUUID)
 *
 * Run:
 *   TEXTCONVO_API_KEY=... TEXTCONVO_SOURCE_KEY=... node ingest-lead.js
 */

'use strict';

const crypto = require('node:crypto');

const BASE_URL = process.env.TEXTCONVO_BASE_URL || 'https://api.textconvo.ai';
const API_KEY = process.env.TEXTCONVO_API_KEY;
const SOURCE_KEY = process.env.TEXTCONVO_SOURCE_KEY;
const HMAC_SECRET = process.env.TEXTCONVO_HMAC_SECRET || '';

if (!API_KEY || !SOURCE_KEY) {
  console.error('Set TEXTCONVO_API_KEY and TEXTCONVO_SOURCE_KEY. See .env.example');
  process.exit(1);
}

/** Errors we should never retry: the same request will fail the same way. */
class TextConvoError extends Error {
  constructor(status, code, message, requestId) {
    super(message);
    this.name = 'TextConvoError';
    this.status = status;
    this.code = code;
    this.requestId = requestId;
  }
}

/** Retryable: transient network problems, rate limits, and 5xx. */
class TextConvoRetryableError extends TextConvoError {
  constructor(status, code, message, requestId, retryAfterSeconds) {
    super(status, code, message, requestId);
    this.name = 'TextConvoRetryableError';
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Exponential backoff with full jitter. Jitter matters: without it, every
 * client that failed at the same moment retries at the same moment.
 */
function backoffMs(attempt, retryAfterSeconds) {
  if (retryAfterSeconds) return retryAfterSeconds * 1000;
  const base = Math.min(1000 * Math.pow(2, attempt), 30000);
  return Math.floor(Math.random() * base);
}

/**
 * Ingest a lead.
 *
 * The request id is the idempotency key. Keep it stable across retries of the
 * same logical lead so a network timeout cannot create a duplicate.
 */
async function ingestLead(lead, options) {
  const opts = options || {};
  const requestId = opts.requestId || crypto.randomUUID();
  const maxAttempts = opts.maxAttempts || 4;

  // Serialise ONCE. The exact string below is what we sign and what we send.
  const rawBody = JSON.stringify(lead);

  const headers = {
    'Content-Type': 'application/json',
    'X-API-Key': API_KEY,
    'X-Source-Key': SOURCE_KEY,
    'X-Request-Id': requestId
  };

  // Optional per-source HMAC signing: hex(HMAC_SHA256(secret, timestamp + '.' + rawBody))
  if (HMAC_SECRET) {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    headers['X-TC-Timestamp'] = timestamp;
    headers['X-TC-Signature'] = crypto
      .createHmac('sha256', HMAC_SECRET)
      .update(timestamp + '.' + rawBody)
      .digest('hex');
  }

  let lastError;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) {
      const wait = backoffMs(attempt, lastError && lastError.retryAfterSeconds);
      console.warn('Retry ' + attempt + ' of ' + (maxAttempts - 1) + ' in ' + wait + 'ms');
      await sleep(wait);
    }

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);

      const response = await fetch(BASE_URL + '/functions/v1/ingest-lead', {
        method: 'POST',
        headers: headers,
        body: rawBody,
        signal: controller.signal
      });

      clearTimeout(timeout);

      const text = await response.text();
      let payload = {};
      try { payload = text ? JSON.parse(text) : {}; } catch (_) { payload = { raw: text }; }

      // 202 Accepted: queued. payload.duplicate === true means this request id
      // was already processed, which is exactly what we want from a safe retry.
      if (response.status === 202) {
        return { requestId: requestId, status: response.status, body: payload };
      }

      // 429: honour the hint. Prefer the documented retry_after, fall back to the header.
      if (response.status === 429) {
        const retryAfter = Number(payload.retry_after || response.headers.get('retry-after') || 0);
        throw new TextConvoRetryableError(429, 'RATE_LIMITED', payload.error || 'Rate limit exceeded', requestId, retryAfter || undefined);
      }

      if (response.status >= 500) {
        throw new TextConvoRetryableError(response.status, payload.code || 'SERVER_ERROR', payload.error || 'Server error', requestId);
      }

      // 400, 401, 403 and friends: a retry changes nothing. Fix the request.
      throw new TextConvoError(response.status, payload.code || 'REQUEST_ERROR', payload.error || ('Unexpected status ' + response.status), requestId);
    } catch (error) {
      const isNetwork = error.name === 'AbortError' || error.name === 'TypeError' || error.code === 'ECONNRESET';
      if (error instanceof TextConvoRetryableError || isNetwork) {
        lastError = error;
        continue;
      }
      throw error;
    }
  }

  throw lastError;
}

async function main() {
  // phone is the only required field, in E.164 format.
  // Anything non-standard belongs under custom_fields, not at the top level.
  const lead = {
    phone: process.env.TEST_PHONE || '+15035551234',
    first_name: 'Jane',
    last_name: 'Doe',
    email: 'jane.doe@example.com',
    external_id: 'crm_00042',
    city: 'Portland',
    state: 'OR',
    metadata: { campaign: 'spring-promo' },
    custom_fields: { roof_age_years: '12' }
  };

  try {
    const result = await ingestLead(lead);
    console.log('Accepted. Request id: ' + result.requestId);
    console.log(JSON.stringify(result.body, null, 2));
    if (result.body.duplicate) {
      console.log('Already ingested under this request id — idempotency did its job.');
    }
    console.log('Progress arrives by webhook: https://textconvo.ai/docs#webhooks');
  } catch (error) {
    if (error instanceof TextConvoError) {
      console.error('Failed [' + error.status + ' ' + error.code + ']: ' + error.message);
      console.error('Request id for support: ' + error.requestId);
      process.exitCode = 1;
      return;
    }
    throw error;
  }
}

main();

module.exports = { ingestLead, TextConvoError, TextConvoRetryableError };
