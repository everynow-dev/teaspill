/**
 * Register-before-server-up race handling (0001:T6.2, the load-bearing fix).
 *
 * PLAN §5 0001:T6.2 / 0001:D6: the electric-agents boot-order bug ("Stream not found",
 * deployment registered before the gateway/Restate is accepting requests) is
 * avoided by (1) WAITING on gateway health before registering, and
 * (2) registering with exponential backoff so a not-yet-ready gateway or a
 * not-yet-listening deployment retries instead of failing the dev loop.
 *
 * Everything here is injectable (`sleep`, the probe, the register fn) so the
 * retry/backoff is unit-tested WITHOUT a live stack — the anticipated bug's
 * regression test lives in `register.test.ts`.
 */

export interface BackoffOptions {
  /** Max attempts before giving up. Default 10. */
  maxAttempts?: number;
  /** First delay in ms. Default 250. */
  baseDelayMs?: number;
  /** Delay ceiling in ms (exponential is capped here). Default 5000. */
  maxDelayMs?: number;
  /** Injectable sleep (ms). Default a real timer; abortable via `signal`. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Abort the whole wait/retry loop. */
  signal?: AbortSignal;
  /** Called before each sleep (attempt is 1-based; the attempt that just failed). */
  onRetry?: (info: { attempt: number; delayMs: number; error?: unknown }) => void;
}

/** Exponential-with-cap delay for a 1-based attempt number. */
export function backoffDelay(attempt: number, baseDelayMs: number, maxDelayMs: number): number {
  const raw = baseDelayMs * 2 ** (attempt - 1);
  return Math.min(raw, maxDelayMs);
}

export async function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted === true) throw new AbortError();
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = (): void => {
      cleanup();
      clearTimeout(timer);
      reject(new AbortError());
    };
    const cleanup = (): void => signal?.removeEventListener("abort", onAbort);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export class AbortError extends Error {
  constructor() {
    super("aborted");
    this.name = "AbortError";
  }
}

export class GatewayUnhealthyError extends Error {
  constructor(public readonly attempts: number) {
    super(`gateway did not become healthy after ${attempts} attempt(s)`);
    this.name = "GatewayUnhealthyError";
  }
}

/**
 * Poll a health probe until it returns `true`, backing off between attempts.
 * The probe fails N times then succeeds → this resolves on the (N+1)th call.
 * Throws `GatewayUnhealthyError` after `maxAttempts` failures.
 */
export async function waitForHealthy(
  probe: () => Promise<boolean>,
  opts: BackoffOptions = {},
): Promise<void> {
  const maxAttempts = opts.maxAttempts ?? 10;
  const baseDelayMs = opts.baseDelayMs ?? 250;
  const maxDelayMs = opts.maxDelayMs ?? 5000;
  const sleep = opts.sleep ?? defaultSleep;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (opts.signal?.aborted === true) throw new AbortError();
    let healthy: boolean;
    let error: unknown;
    try {
      healthy = await probe();
    } catch (e) {
      // A connection-refused before the port is open is expected — treat a
      // throwing probe as "not healthy yet" and keep retrying.
      error = e;
      healthy = false;
    }
    if (healthy) return;
    if (attempt === maxAttempts) throw new GatewayUnhealthyError(maxAttempts);
    const delayMs = backoffDelay(attempt, baseDelayMs, maxDelayMs);
    opts.onRetry?.({ attempt, delayMs, ...(error !== undefined ? { error } : {}) });
    await sleep(delayMs, opts.signal);
  }
  throw new GatewayUnhealthyError(maxAttempts);
}

/**
 * Run an async operation with exponential backoff, retrying on any throw
 * (unless `isRetryable` says otherwise). Returns the operation's value on the
 * first success. Rethrows the last error after `maxAttempts`.
 */
export async function retryWithBackoff<T>(
  operation: (attempt: number) => Promise<T>,
  opts: BackoffOptions & { isRetryable?: (error: unknown) => boolean } = {},
): Promise<T> {
  const maxAttempts = opts.maxAttempts ?? 10;
  const baseDelayMs = opts.baseDelayMs ?? 250;
  const maxDelayMs = opts.maxDelayMs ?? 5000;
  const sleep = opts.sleep ?? defaultSleep;
  const isRetryable = opts.isRetryable ?? (() => true);

  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (opts.signal?.aborted === true) throw new AbortError();
    try {
      return await operation(attempt);
    } catch (error) {
      lastError = error;
      if (attempt === maxAttempts || !isRetryable(error)) throw error;
      const delayMs = backoffDelay(attempt, baseDelayMs, maxDelayMs);
      opts.onRetry?.({ attempt, delayMs, error });
      await sleep(delayMs, opts.signal);
    }
  }
  throw lastError;
}

/**
 * Default gateway-health probe: `GET <gatewayUrl>/health` is 2xx.
 * A network error (port not open yet) rejects → `waitForHealthy` treats it as
 * not-ready and retries.
 */
export function createHealthProbe(
  gatewayUrl: string,
  fetchImpl: typeof fetch = fetch,
): () => Promise<boolean> {
  const url = `${gatewayUrl.replace(/\/+$/, "")}/health`;
  return async () => {
    const res = await fetchImpl(url, { method: "GET" });
    return res.ok;
  };
}
