import type { NextFunction, Request, Response } from "express"
import type { QueryCounter } from "../db/query-scope"

export const QUERY_COUNT_REQUEST_HEADER = "x-query-count"

/**
 * Reports a response's database work as `Server-Timing: db;desc="<n> queries"`
 * when the request sends `x-query-count`. Counts what ran before the headers
 * were written. Opt-in per request: Bun drops async stack frames while an
 * AsyncLocalStorage store is active, so only a request that asks pays that.
 */
export function createQueryTimingMiddleware(queryCounter: QueryCounter) {
  return function queryTimingMiddleware(req: Request, res: Response, next: NextFunction): void {
    if (req.get(QUERY_COUNT_REQUEST_HEADER) === undefined) {
      next()
      return
    }
    queryCounter.run((scope) => {
      const writeHead = res.writeHead
      res.writeHead = function (this: Response, ...args: Parameters<Response["writeHead"]>) {
        res.setHeader("Server-Timing", `db;desc="${scope.count} queries"`)
        return writeHead.apply(this, args)
      } as Response["writeHead"]
      next()
    })
  }
}
