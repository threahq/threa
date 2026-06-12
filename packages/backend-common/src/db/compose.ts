import type { QueryConfig } from "pg"

/** A `QueryConfig` fragment with `values` guaranteed present (squid always emits it). */
type SqlFragment = { text: string; values: unknown[] }

/**
 * Type guard for a squid/pg `QueryConfig`-shaped fragment: `{ text, values }`.
 * Used to decide whether an interpolated value is spliced inline (a nested
 * fragment) or parametrized as an ordinary value.
 */
function isQueryConfig(value: unknown): value is SqlFragment {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { text?: unknown }).text === "string" &&
    Array.isArray((value as { values?: unknown }).values)
  )
}

/**
 * `sql`-compatible tagged template that additionally splices nested
 * `QueryConfig` fragments inline.
 *
 * squid's own `sql` tag cannot nest one `sql`` fragment inside another:
 * interpolating a `QueryConfig` parametrizes the whole object as a single
 * value. `composeSql` behaves exactly like `sql` for plain values (each is
 * emitted as `$n` and collected into `values`), but when an interpolated
 * value is `QueryConfig`-shaped its `text` is inlined with every `$k`
 * placeholder renumbered to follow the outer query's parameters, and its
 * `values` are appended in order. This lets a single canonical predicate
 * fragment be shared across queries without copy-pasting the SQL.
 *
 * Fragment placeholders are assumed to be the standard `$1..$k` produced by
 * squid `sql`` (1-indexed, contiguous), which is the only kind of fragment we
 * compose here.
 */
export function composeSql(texts: TemplateStringsArray, ...values: unknown[]): QueryConfig {
  let text = ""
  const outValues: unknown[] = []

  for (let i = 0; i < texts.length; i++) {
    text += texts[i]
    if (i >= values.length) continue

    const value = values[i]
    if (isQueryConfig(value)) {
      // Renumber the fragment's $k placeholders to continue after the
      // parameters already accumulated, then append its values in order.
      const offset = outValues.length
      text += value.text.replace(/\$(\d+)/g, (_match, n: string) => `$${Number(n) + offset}`)
      outValues.push(...value.values)
    } else {
      outValues.push(value)
      text += `$${outValues.length}`
    }
  }

  return { text, values: outValues }
}
