// Worker → web completion webhook with retry (admin data tools §1.3).
//
// The worker used to fire one POST and ignore the response, so a lost/5xx webhook left the ingest
// job "running" forever. This posts, checks `res.ok`, and retries with backoff, re-stamping
// `x-webhook-timestamp` each attempt (the shell accepts ≤ 5 min old / ≤ 1 min future). It never
// throws: the processing result is already in the DB, and the provider reconcile is the backstop.
// It is ONLY for the success path — a failing attempt must not post `error`, because Step
// Functions may still retry the task and an early close would let a delete land between attempts.

export const WEBHOOK_RETRY_DELAYS_MS: readonly number[] = [1_000, 4_000, 15_000];

export interface WebhookNotifyOptions {
  url: string;
  secret: string;
  body: unknown;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  delaysMs?: readonly number[];
  now?: () => number;
  log?: (message: string) => void;
}

export async function notifyProcessingWebhook(
  options: WebhookNotifyOptions,
): Promise<{ delivered: boolean; attempts: number; lastStatus: number | null }> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep =
    options.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const delays = options.delaysMs ?? WEBHOOK_RETRY_DELAYS_MS;
  const now = options.now ?? Date.now;
  const log = options.log ?? ((message: string) => console.warn(message));
  const payload = JSON.stringify(options.body);
  let lastStatus: number | null = null;

  for (let attempt = 0; attempt <= delays.length; attempt++) {
    if (attempt > 0) await sleep(delays[attempt - 1]);
    try {
      const res = await fetchImpl(options.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${options.secret}`,
          "x-webhook-timestamp": `${now()}`,
        },
        body: payload,
      });
      lastStatus = res.status;
      if (res.ok) return { delivered: true, attempts: attempt + 1, lastStatus };
      // A 4xx other than 408/429 will not change on retry (bad secret, bad payload, gone project).
      if (res.status < 500 && res.status !== 408 && res.status !== 429) {
        log(`[worker] Webhook rejected with HTTP ${res.status}; not retrying`);
        return { delivered: false, attempts: attempt + 1, lastStatus };
      }
      log(`[worker] Webhook attempt ${attempt + 1} got HTTP ${res.status}`);
    } catch (error) {
      const name = error instanceof Error ? error.name : "Error";
      log(`[worker] Webhook attempt ${attempt + 1} failed (${name})`);
    }
  }
  log("[worker] Webhook not delivered; the Stuck jobs reconcile will close this job");
  return { delivered: false, attempts: delays.length + 1, lastStatus };
}
