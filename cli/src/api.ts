/**
 * The broker's `/api/cloud/v1` with an account API token (D-175): offers, minutes, and the rentals this token
 * started. The broker never sees the phone: `connect` answers the phone host's viewer URL and a one-use control
 * grant for the renter door (`door.ts`).
 */

export const DEFAULT_URL = 'https://benchfleet.com';
const TOKEN_SHAPE = /^bfc_[A-Za-z0-9_-]{43}$/;

export interface Rental {
  id: string;
  state: 'requested' | 'starting' | 'ready' | 'releasing' | 'released' | 'failed';
  offer_id: string;
  android_version: string | null;
  screen: string;
  root: boolean;
  max_minutes: number;
  minutes_used: number;
  cost: number;
  stop_reason: string | null;
  error: string | null;
  name: string | null;
}

export interface StartOptions {
  offer_id: string;
  max_minutes: number;
  screen?: string;
  root?: boolean;
  name?: string;
  wipe?: boolean;
}

/** A refusal or failure from the broker, with its code (`insufficient_balance`, `token_spending_limit`, …). */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export class CloudApi {
  readonly url: string;
  readonly #token: string;
  readonly #fetch: typeof fetch;
  /** More headers on every request: a Cloudflare Access service token for the private staging copy. */
  readonly #extra: Record<string, string>;

  constructor(token: string, url = DEFAULT_URL, fetcher: typeof fetch = fetch, extraHeaders: Record<string, string> = {}) {
    if (!TOKEN_SHAPE.test(token)) throw new Error('the API token must look like bfc_… (make one on your account page, API tokens)');
    this.url = url.replace(/\/+$/, '');
    this.#token = token;
    this.#fetch = fetcher;
    this.#extra = extraHeaders;
  }

  async call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { ...this.#extra, Authorization: `Bearer ${this.#token}`, Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    let res: Response;
    try {
      res = await this.#fetch(`${this.url}/api/cloud/v1${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    } catch (err) {
      throw new ApiError(0, 'network', `could not reach ${this.url}: ${(err as Error).message}`);
    }
    const data = (await res.json().catch(() => null)) as { error?: { code?: string; message?: string } } | null;
    if (!res.ok) {
      throw new ApiError(res.status, data?.error?.code ?? 'http_' + res.status, data?.error?.message ?? `HTTP ${res.status}`);
    }
    return data as T;
  }

  offers(): Promise<{ offers: { id: string; android_version: string; name: string }[]; screens: { id: string; name: string }[] }> {
    return this.call('GET', '/offers');
  }

  balance(): Promise<Record<string, unknown>> {
    return this.call('GET', '/balance');
  }

  async start(o: StartOptions): Promise<Rental> {
    return (await this.call<{ rental: Rental }>('POST', '/rentals', o)).rental;
  }

  async rental(id: string): Promise<Rental> {
    return (await this.call<{ rental: Rental }>('GET', `/rentals/${encodeURIComponent(id)}`)).rental;
  }

  async extend(id: string, minutes: number): Promise<Rental> {
    return (await this.call<{ rental: Rental }>('POST', `/rentals/${encodeURIComponent(id)}/extend`, { minutes })).rental;
  }

  async release(id: string): Promise<Rental> {
    return (await this.call<{ rental: Rental }>('POST', `/rentals/${encodeURIComponent(id)}/release`)).rental;
  }

  /** A control grant for the phone's renter door: use it within 60 seconds, once. */
  connect(id: string): Promise<{ url: string; grant: string }> {
    return this.call('POST', `/rentals/${encodeURIComponent(id)}/connect`);
  }

  /** Waits until the phone is ready (or has ended); polls every `everyS` seconds. */
  async waitReady(id: string, timeoutS = 900, everyS = 5, sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))): Promise<Rental> {
    const until = Date.now() + timeoutS * 1000;
    for (;;) {
      const r = await this.rental(id);
      if (r.state === 'ready') return r;
      if (r.state === 'released' || r.state === 'failed' || r.state === 'releasing') {
        throw new ApiError(409, 'ended', `the phone ended before it was ready (${r.error ?? r.stop_reason ?? r.state})`);
      }
      if (Date.now() >= until) throw new ApiError(408, 'not_ready_in_time', `the phone was not ready within ${timeoutS} s`);
      await sleep(everyS * 1000);
    }
  }
}
