/**
 * TextConvo — TypeScript example
 *
 * Typed request and response shapes for lead ingestion, with narrow error
 * handling. Drop this file into a server-side project; it has no dependencies
 * beyond Node 18+ (global fetch, node:crypto).
 *
 * Docs: https://textconvo.ai/docs#lead-ingestion-api
 */

import { createHmac, randomUUID } from 'node:crypto';

// --- Types -----------------------------------------------------------------

/** Only `phone` is required. Unknown top-level keys are rejected — use customFields. */
export interface Lead {
  phone: string;                 // E.164, e.g. +15035551234
  email?: string;
  external_id?: string;          // your CRM id for this person
  lead_external_id?: string;     // alias of external_id
  first_name?: string;
  last_name?: string;
  address?: string;
  city?: string;
  state?: string;                // normalised to a 2-letter code
  zip?: string;
  affiliate_id?: string;
  ip_address?: string;
  user_agent?: string;
  landing_page?: string;
  metadata?: Record<string, unknown>;      // max 2KB
  custom_fields?: Record<string, unknown>; // max 2KB, home for everything non-standard
}

export interface IngestAccepted {
  success: true;
  ingestion_request_id: string;
  duplicate?: boolean;
}

export interface IngestFailed {
  success: false;
  error: string;
  code?: string;
  retry_after?: number;
}

export interface ClientConfig {
  apiKey: string;
  sourceKey: string;
  baseUrl?: string;
  hmacSecret?: string;   // only if signing is enabled for your source
  timeoutMs?: number;
}

export class TextConvoError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly requestId: string,
    readonly retryable: boolean,
    readonly retryAfterSeconds?: number
  ) {
    super(message);
    this.name = 'TextConvoError';
  }
}

// --- Client ----------------------------------------------------------------

export class TextConvoClient {
  private readonly baseUrl: string;

  constructor(private readonly config: ClientConfig) {
    this.baseUrl = config.baseUrl ?? 'https://api.textconvo.ai';
  }

  /**
   * Ingest a lead. Pass a stable requestId to make retries idempotent — the
   * second call returns the original result with duplicate: true.
   */
  async ingestLead(lead: Lead, requestId: string = randomUUID()): Promise<IngestAccepted> {
    // Serialise once: the exact string we sign is the exact string we send.
    const rawBody = JSON.stringify(lead);

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-API-Key': this.config.apiKey,
      'X-Source-Key': this.config.sourceKey,
      'X-Request-Id': requestId
    };

    if (this.config.hmacSecret) {
      const timestamp = Math.floor(Date.now() / 1000).toString();
      headers['X-TC-Timestamp'] = timestamp;
      headers['X-TC-Signature'] = createHmac('sha256', this.config.hmacSecret)
        .update(timestamp + '.' + rawBody)
        .digest('hex');
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs ?? 10_000);

    let response: Response;
    try {
      response = await fetch(this.baseUrl + '/functions/v1/ingest-lead', {
        method: 'POST',
        headers,
        body: rawBody,
        signal: controller.signal
      });
    } finally {
      clearTimeout(timer);
    }

    const payload = (await response.json().catch(() => ({}))) as Partial<IngestAccepted & IngestFailed>;

    if (response.status === 202 && payload.success) {
      return payload as IngestAccepted;
    }

    const retryable = response.status === 429 || response.status >= 500;
    const retryAfter =
      payload.retry_after ?? Number(response.headers.get('retry-after') ?? 0) || undefined;

    throw new TextConvoError(
      response.status,
      payload.code ?? (response.status === 429 ? 'RATE_LIMITED' : 'REQUEST_ERROR'),
      payload.error ?? ('Unexpected status ' + response.status),
      requestId,
      retryable,
      retryAfter
    );
  }

  /** Ingest with exponential backoff and full jitter, retrying only what is retryable. */
  async ingestLeadWithRetry(lead: Lead, maxAttempts = 4): Promise<IngestAccepted> {
    const requestId = randomUUID(); // stable across attempts — this is the point
    let lastError: TextConvoError | undefined;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        return await this.ingestLead(lead, requestId);
      } catch (error) {
        if (!(error instanceof TextConvoError) || !error.retryable) throw error;
        lastError = error;
        const hinted = error.retryAfterSeconds ? error.retryAfterSeconds * 1000 : 0;
        const capped = Math.min(1000 * 2 ** attempt, 30_000);
        const wait = hinted || Math.floor(Math.random() * capped);
        await new Promise((resolve) => setTimeout(resolve, wait));
      }
    }

    throw lastError;
  }
}

// --- Usage -----------------------------------------------------------------

async function main(): Promise<void> {
  const client = new TextConvoClient({
    apiKey: process.env.TEXTCONVO_API_KEY!,
    sourceKey: process.env.TEXTCONVO_SOURCE_KEY!,
    hmacSecret: process.env.TEXTCONVO_HMAC_SECRET || undefined
  });

  try {
    const accepted = await client.ingestLeadWithRetry({
      phone: process.env.TEST_PHONE ?? '+15035551234',
      first_name: 'Jane',
      last_name: 'Doe',
      email: 'jane.doe@example.com',
      state: 'OR',
      custom_fields: { roof_age_years: '12' }
    });

    console.log('Queued:', accepted.ingestion_request_id, accepted.duplicate ? '(duplicate)' : '');
  } catch (error) {
    if (error instanceof TextConvoError) {
      console.error('Failed [' + error.status + ' ' + error.code + ']: ' + error.message);
      console.error('Quote this request id to support: ' + error.requestId);
      process.exitCode = 1;
      return;
    }
    throw error;
  }
}

if (require.main === module) void main();
