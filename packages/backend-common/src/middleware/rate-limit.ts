import type { NextFunction, Request, RequestHandler, Response } from "express"

interface RateLimitBucket {
  count: number
  resetAt: number
}

export interface RateLimitRejection {
  limit: number
  windowMs: number
  retryAfterSeconds: number
}

export interface RateLimitOptions {
  name: string
  windowMs: number
  max: number
  key: (req: Request) => string
  skip?: (req: Request) => boolean
  /** Writes the 429 for callers that cannot read the default JSON body (Slack wants text/plain). */
  respond?: (req: Request, res: Response, rejection: RateLimitRejection) => void
}

function setRateLimitHeaders(res: Response, max: number, remaining: number, resetAt: number): void {
  const secondsUntilReset = Math.max(0, Math.ceil((resetAt - Date.now()) / 1000))
  res.setHeader("RateLimit-Limit", String(max))
  res.setHeader("RateLimit-Remaining", String(Math.max(0, remaining)))
  res.setHeader("RateLimit-Reset", String(secondsUntilReset))
}

function cleanupExpiredBuckets(buckets: Map<string, RateLimitBucket>, now: number): void {
  if (buckets.size < 10_000) return
  for (const [key, bucket] of buckets.entries()) {
    if (bucket.resetAt <= now) {
      buckets.delete(key)
    }
  }
}

export function createRateLimit(options: RateLimitOptions): RequestHandler {
  const buckets = new Map<string, RateLimitBucket>()

  return function rateLimitMiddleware(req: Request, res: Response, next: NextFunction): void {
    if (options.skip?.(req)) {
      return next()
    }

    const now = Date.now()
    cleanupExpiredBuckets(buckets, now)

    const bucketKey = `${options.name}:${options.key(req)}`
    const existing = buckets.get(bucketKey)
    const bucket: RateLimitBucket =
      existing && existing.resetAt > now
        ? existing
        : {
            count: 0,
            resetAt: now + options.windowMs,
          }

    if (bucket.count >= options.max) {
      setRateLimitHeaders(res, options.max, 0, bucket.resetAt)
      const rejection: RateLimitRejection = {
        limit: options.max,
        windowMs: options.windowMs,
        retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)),
      }
      if (options.respond) {
        options.respond(req, res, rejection)
        return
      }
      res.status(429).json({
        error: "Rate limit exceeded",
        limit: rejection.limit,
        windowMs: rejection.windowMs,
      })
      return
    }

    bucket.count += 1
    buckets.set(bucketKey, bucket)
    setRateLimitHeaders(res, options.max, options.max - bucket.count, bucket.resetAt)
    next()
  }
}

export function getClientIp(req: Request, fallback = ""): string {
  return req.ip || fallback
}
