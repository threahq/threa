import type { Pool, PoolConfig } from "pg"

/**
 * `public.now()` shadows `pg_catalog.now()` only when `public` precedes `pg_catalog` on the
 * search_path, so every pool on a sim-clock database must connect with this option.
 */
export const SIM_CLOCK_POOL_CONFIG: Partial<PoolConfig> = { options: "-c search_path=public,pg_catalog" }

/**
 * Column `DEFAULT NOW()` binds to whichever `now()` resolves at CREATE TABLE time, so this runs
 * before migrations. CURRENT_TIMESTAMP is a keyword and is not shadowed.
 */
async function installSimClock(pool: Pool, start: Date): Promise<void> {
  await pool.query(`
    CREATE TABLE public.eval_clock (
      singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
      t TIMESTAMPTZ NOT NULL
    )
  `)
  await pool.query("INSERT INTO public.eval_clock (t) VALUES ($1)", [start])
  await pool.query(`
    CREATE FUNCTION public.now() RETURNS TIMESTAMPTZ LANGUAGE sql STABLE
    AS $$ SELECT t FROM public.eval_clock $$
  `)
}

async function hasSimClock(pool: Pool): Promise<boolean> {
  const result = await pool.query("SELECT to_regclass('public.eval_clock') IS NOT NULL AS present")
  return result.rows[0].present
}

/** Simulated wall clock shared by the eval database's `now()` and the pipeline's injected clock. */
export class SimClock {
  private current: Date

  private constructor(
    private readonly pool: Pool,
    start: Date
  ) {
    this.current = new Date(start)
  }

  /** Installs the clock in a fresh, unmigrated database. */
  static async install(pool: Pool, start: Date): Promise<SimClock> {
    await installSimClock(pool, start)
    return new SimClock(pool, start)
  }

  /** Takes over the clock a cloned database already carries, restarting it at `start`. */
  static async attach(pool: Pool, start: Date): Promise<SimClock> {
    const clock = new SimClock(pool, start)
    await pool.query("UPDATE public.eval_clock SET t = $1", [start])
    return clock
  }

  now = (): Date => new Date(this.current)

  async set(next: Date): Promise<void> {
    if (next.getTime() < this.current.getTime()) {
      throw new Error(`SimClock cannot go backwards: ${next.toISOString()} < ${this.current.toISOString()}`)
    }
    await this.pool.query("UPDATE public.eval_clock SET t = $1", [next])
    this.current = new Date(next)
  }
}

/**
 * A database's defaults are bound to one clock for life: a clone must agree with its source, or
 * its rows would silently be stamped by the other clock.
 */
export async function assertClockMatches(pool: Pool, source: string, simClock: boolean): Promise<void> {
  const present = await hasSimClock(pool)
  if (present === simClock) return
  throw new Error(
    present
      ? `${source} carries a simulated clock; the suite must opt into simClock to reuse it`
      : `${source} was created without a simulated clock; its column defaults read real time`
  )
}
