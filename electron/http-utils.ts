// Shared HTTP helpers for AI-provider calls.
// - Per-call timeout via AbortController (default 90s; image gen can take a while)
// - Exponential backoff retry on transient failures (network errors, 408/429/5xx)
// - Honors Retry-After when present
// Side note: only retries idempotent intent. Even POST is acceptable for the AI
// providers we use because requests have no side effects beyond billing.

export interface FetchRetryOpts {
  /** Total retry attempts (in addition to the initial try). Default 2. */
  retries?: number;
  /** Base backoff in ms (doubled per attempt). Default 800. */
  backoffMs?: number;
  /** Per-attempt timeout in ms. Default 90_000. */
  timeoutMs?: number;
  /** Optional label for log messages. */
  label?: string;
  /**
   * Whether a per-attempt timeout (AbortError) should be retried. Default true.
   *
   * For long, expensive single-shot calls (e.g. gpt-image-2 edits that already
   * average ~200s) a timeout almost never means "try again and it'll be fast" —
   * it means the request was genuinely slow, so retrying just doubles the wall
   * time and the bill. Set false there so a timeout fails fast; transient
   * 5xx/network errors are still retried via `retries`.
   */
  retryOnTimeout?: boolean;
}

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function retryAfterMs(headers: Headers): number | null {
  const raw = headers.get("retry-after");
  if (!raw) return null;
  const sec = Number(raw);
  if (Number.isFinite(sec)) return Math.max(0, sec * 1000);
  const dateMs = Date.parse(raw);
  if (Number.isFinite(dateMs)) return Math.max(0, dateMs - Date.now());
  return null;
}

export async function fetchWithRetry(
  url: string,
  init: RequestInit = {},
  opts: FetchRetryOpts = {},
): Promise<Response> {
  const {
    retries = 2,
    backoffMs = 800,
    timeoutMs = 90_000,
    label = "fetch",
    retryOnTimeout = true,
  } = opts;
  let attempt = 0;
  let lastErr: unknown;

  while (attempt <= retries) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...init, signal: ctrl.signal });
      clearTimeout(timer);
      if (res.ok || !RETRYABLE_STATUS.has(res.status) || attempt === retries) {
        return res;
      }
      const wait = retryAfterMs(res.headers) ?? backoffMs * 2 ** attempt;
      console.warn(
        `[${label}] HTTP ${res.status} on attempt ${attempt + 1}/${retries + 1}. Retrying in ${wait}ms.`,
      );
      await sleep(wait);
    } catch (err) {
      clearTimeout(timer);
      lastErr = err;
      const aborted = (err as { name?: string }).name === "AbortError";
      // A timeout on a deliberately long call is not a transient hiccup —
      // retrying just doubles the wait + bill. Fail fast when opted out.
      if (aborted && !retryOnTimeout) {
        throw new Error(`${label} timed out after ${timeoutMs}ms`);
      }
      if (attempt === retries) {
        throw aborted
          ? new Error(`${label} timed out after ${timeoutMs}ms`)
          : err;
      }
      const wait = backoffMs * 2 ** attempt;
      console.warn(
        `[${label}] ${aborted ? "timeout" : "network error"} on attempt ${attempt + 1}/${retries + 1}. Retrying in ${wait}ms.`,
      );
      await sleep(wait);
    }
    attempt += 1;
  }
  // Should never reach here, but TS needs it.
  throw lastErr ?? new Error(`${label} exhausted retries`);
}
