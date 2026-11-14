import type { NextFunction, Request, Response } from "express"
import type { QueryCounter } from "../db/query-scope"

/**
 * Reports each response's database work as `Server-Timing: db;desc="<n> queries"`.
 * Counts what ran before the headers were written.
 */
export function createQueryTimingMiddleware(queryCounter: QueryCounter) {
  return function queryTimingMiddleware(_req: Request, res: Response, next: NextFunction): void {
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
