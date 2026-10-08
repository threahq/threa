import type { Pool, PoolConfig } from "pg"

/**
 * `public.now()` shadows `pg_catalog.now()` only when `public` precedes `pg_catalog` on the
 * search_path, so every pool on a sim-clock database must connect with this option.
 */
export const SIM_CLOCK_POOL_CONFIG: Partial<PoolConfig> = { options: "-c search_path=public,pg_catalog" }

/** Simulated wall clock shared by the eval database's `now()` and the pipeline's injected clock. */
export class SimClock {
  private current: Date

  private constructor(
    private readonly pool: Pool,
    start: Date
  ) {
    this.current = new Date(start)
  }

  /**
   * Column `DEFAULT NOW()` binds to whichever `now()` resolves at CREATE TABLE time, so this runs
   * on a fresh database before migrations. CURRENT_TIMESTAMP is a keyword and is not shadowed.
   */
  static async install(pool: Pool, start: Date): Promise<SimClock> {
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
    return new SimClock(pool, start)
  }

  /** Takes over the clock a cloned database already carries, restarting it at `start`. */
  static async attach(pool: Pool, start: Date): Promise<SimClock> {
    const clock = new SimClock(pool, start)
    await pool.query("UPDATE public.eval_clock SET t = $1", [start])
    return clock
  }

  /** Takes over a reused database's clock where it stopped, so time never runs backwards over its rows. */
  static async resume(pool: Pool): Promise<SimClock> {
    const result = await pool.query<{ t: Date }>("SELECT t FROM public.eval_clock")
    return new SimClock(pool, result.rows[0].t)
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
  const result = await pool.query("SELECT to_regclass('public.eval_clock') IS NOT NULL AS present")
  const present: boolean = result.rows[0].present
  if (present === simClock) return
  throw new Error(
    present
      ? `${source} carries a simulated clock; the suite must opt into simClock to reuse it`
      : `${source} was created without a simulated clock; its column defaults read real time`
  )
}
