import { AsyncLocalStorage, AsyncResource } from "node:async_hooks"
import type { Pool, PoolClient } from "pg"

export interface QueryScope {
  count: number
}

/** Counts the queries its instrumented pools run inside each `run` scope. */
export class QueryCounter {
  private readonly activeScope = new AsyncLocalStorage<QueryScope>()

  run<T>(fn: (scope: QueryScope) => T): T {
    const scope: QueryScope = { count: 0 }
    return this.activeScope.run(scope, () => fn(scope))
  }

  /**
   * pg-pool runs a queued checkout's callback in the async context of the
   * caller that released the connection; binding it to the requesting caller
   * keeps `pool.query` counting into its own scope.
   */
  instrument(pool: Pool): void {
    const connect = pool.connect.bind(pool) as (cb?: ConnectCallback) => Promise<PoolClient> | void
    pool.connect = ((cb?: ConnectCallback) => (cb ? connect(AsyncResource.bind(cb)) : connect())) as Pool["connect"]

    pool.on("connect", (client) => {
      const query = client.query.bind(client) as (...args: unknown[]) => unknown
      client.query = ((...args: unknown[]) => {
        const scope = this.activeScope.getStore()
        if (scope) scope.count++
        return query(...args)
      }) as PoolClient["query"]
    })
  }
}

type ConnectCallback = (
  err: Error | undefined,
  client: PoolClient | undefined,
  done: (release?: unknown) => void
) => void
