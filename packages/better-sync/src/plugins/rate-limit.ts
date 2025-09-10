/**
 * Minimal in-memory token bucket rate limiter for servers.
 * Use with server config:
 * const rl = rateLimit();
 * betterSync({ shouldRateLimit: req => rl.shouldRateLimit(req) })
 */
export function rateLimit(options: { windowMs?: number; max?: number; key?: (req: any) => string | undefined } = {}) {
  const windowMs = options.windowMs ?? 1000;
  const max = options.max ?? 50;
  const keyFn = options.key ?? ((req: any) => String(req?.headers?.["x-forwarded-for"] || req?.socket?.remoteAddress || "anon"));
  const buckets = new Map<string, { count: number; resetAt: number }>();
  return {
    shouldRateLimit(req: any) {
      const key = keyFn(req) ?? "anon";
      const now = Date.now();
      let b = buckets.get(key);
      if (!b || now >= b.resetAt) { b = { count: 0, resetAt: now + windowMs }; buckets.set(key, b); }
      b.count += 1;
      return b.count > max;
    }
  } as const;
}
