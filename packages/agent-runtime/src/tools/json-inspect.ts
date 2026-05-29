/**
 * Pure helpers for inspecting JSON fetched by read_url.
 *
 * Large JSON responses are useless to a model when truncated mid-structure, so
 * instead of slicing the serialized string we expose three views:
 *  - describeShape: a recursive schema skeleton (keys -> types, array element
 *    shape + length) so the model can see the structure at a glance.
 *  - structuralPreview: a sampled copy of the data (first N array items, capped
 *    keys, truncated strings) that stays valid JSON with representative values.
 *  - applySelect: a minimal jq-like path resolver so the model can re-fetch and
 *    drill into a specific subtree.
 */

// Shape skeleton: objects stay nested, arrays/primitives collapse to a string
// descriptor (e.g. "array[42] of {id:string, name:string}", "number").
const SHAPE_MAX_DEPTH = 6
const SHAPE_MAX_KEYS = 50
const INLINE_MAX_DEPTH = 2
const INLINE_MAX_KEYS = 8

// Structural preview: how much real data to keep.
const PREVIEW_MAX_DEPTH = 6
const PREVIEW_ARRAY_SAMPLE = 3
const PREVIEW_OBJECT_KEYS = 30
const PREVIEW_STRING_MAX = 200
// Cap key *length* too, not just key count — pathologically long property names
// would otherwise be copied verbatim and defeat the large-payload size guard.
const SUMMARY_KEY_MAX = 120

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function summarizeKeyName(key: string): string {
  return key.length <= SUMMARY_KEY_MAX ? key : `${key.slice(0, SUMMARY_KEY_MAX)}…(${key.length} chars)`
}

export function typeName(value: unknown): string {
  if (value === null) return "null"
  if (Array.isArray(value)) return "array"
  return typeof value
}

// --- Shape summary -------------------------------------------------------

/** One-line compact descriptor of a value's structure. */
function inlineShape(value: unknown, depth = 0): string {
  if (Array.isArray(value)) {
    if (value.length === 0) return "array[0]"
    if (depth >= INLINE_MAX_DEPTH) return `array[${value.length}]`
    return `array[${value.length}] of ${inlineShape(value[0], depth + 1)}`
  }
  if (isPlainObject(value)) {
    if (depth >= INLINE_MAX_DEPTH) return "object"
    const keys = Object.keys(value)
    const shown = keys.slice(0, INLINE_MAX_KEYS)
    const parts = shown.map((k) => `${summarizeKeyName(k)}:${inlineShape(value[k], depth + 1)}`)
    if (keys.length > shown.length) parts.push("…")
    return `{${parts.join(", ")}}`
  }
  return typeName(value)
}

/**
 * Recursive schema skeleton. Top-level objects stay nested so keys are easy to
 * scan; arrays and primitives collapse to a one-line descriptor string.
 */
export function describeShape(value: unknown, depth = 0): unknown {
  if (Array.isArray(value)) {
    if (value.length === 0) return "array[0]"
    return `array[${value.length}] of ${inlineShape(value[0])}`
  }
  if (isPlainObject(value)) {
    if (depth >= SHAPE_MAX_DEPTH) return inlineShape(value)
    const keys = Object.keys(value)
    const shown = keys.slice(0, SHAPE_MAX_KEYS)
    const out: Record<string, unknown> = {}
    for (const k of shown) out[summarizeKeyName(k)] = describeShape(value[k], depth + 1)
    if (keys.length > shown.length) out["…"] = `(${keys.length - shown.length} more keys)`
    return out
  }
  return typeName(value)
}

// --- Structural preview --------------------------------------------------

/**
 * A sampled copy of the data that stays valid JSON: keeps the first few array
 * items, caps object keys, and truncates long strings. Conveys real example
 * values without serializing the whole payload.
 */
export function structuralPreview(value: unknown, depth = 0): unknown {
  if (typeof value === "string") {
    if (value.length > PREVIEW_STRING_MAX) {
      return `${value.slice(0, PREVIEW_STRING_MAX)}…(${value.length} chars total)`
    }
    return value
  }

  if (Array.isArray(value)) {
    if (depth >= PREVIEW_MAX_DEPTH) return `array[${value.length}]`
    const sample = value.slice(0, PREVIEW_ARRAY_SAMPLE).map((v) => structuralPreview(v, depth + 1))
    if (value.length > PREVIEW_ARRAY_SAMPLE) {
      sample.push(`…(${value.length - PREVIEW_ARRAY_SAMPLE} more items)`)
    }
    return sample
  }

  if (isPlainObject(value)) {
    if (depth >= PREVIEW_MAX_DEPTH) return inlineShape(value)
    const keys = Object.keys(value)
    const shown = keys.slice(0, PREVIEW_OBJECT_KEYS)
    const out: Record<string, unknown> = {}
    for (const k of shown) out[summarizeKeyName(k)] = structuralPreview(value[k], depth + 1)
    if (keys.length > shown.length) out["…"] = `(${keys.length - shown.length} more keys)`
    return out
  }

  return value
}

// --- Path selector (minimal jq-like) -------------------------------------

type PathSegment =
  | { kind: "key"; key: string }
  | { kind: "index"; index: number }
  | { kind: "slice"; start: number | null; end: number | null }
  | { kind: "wild" }

const KEY_CHARS = /[A-Za-z0-9_$-]/

function parseBracket(inner: string): PathSegment | { error: string } {
  const trimmed = inner.trim()
  if (trimmed === "*") return { kind: "wild" }

  // Quoted key: ["weird key"] or ['weird key']
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return { kind: "key", key: trimmed.slice(1, -1) }
  }

  // Slice: a:b, :b, a:, :
  if (trimmed.includes(":")) {
    const [rawStart, rawEnd, extra] = trimmed.split(":")
    if (extra !== undefined) return { error: `Invalid slice '[${inner}]'` }
    const parseBound = (s: string): number | null | { error: string } => {
      if (s.trim() === "") return null
      const n = Number(s)
      if (!Number.isInteger(n)) return { error: `Invalid slice bound '${s}' in '[${inner}]'` }
      return n
    }
    const start = parseBound(rawStart)
    const end = parseBound(rawEnd)
    if (start !== null && typeof start === "object") return start
    if (end !== null && typeof end === "object") return end
    return { kind: "slice", start, end }
  }

  // Integer index (allows negative)
  if (/^-?\d+$/.test(trimmed)) {
    return { kind: "index", index: Number(trimmed) }
  }

  // Bare unquoted key inside brackets
  if (trimmed.length > 0) return { kind: "key", key: trimmed }

  return { error: `Empty bracket '[]'` }
}

function parsePath(input: string): { segments: PathSegment[] } | { error: string } {
  const s = input.trim()
  const segments: PathSegment[] = []
  let i = 0

  if (s[i] === "$") i++ // tolerate JSONPath-style root

  while (i < s.length) {
    const c = s[i]

    if (c === ".") {
      i++
      const start = i
      while (i < s.length && KEY_CHARS.test(s[i]!)) i++
      if (i === start) return { error: `Expected a key after '.' in '${input}'` }
      segments.push({ kind: "key", key: s.slice(start, i) })
      continue
    }

    if (c === "[") {
      const end = s.indexOf("]", i)
      if (end === -1) return { error: `Missing ']' in '${input}'` }
      const seg = parseBracket(s.slice(i + 1, end))
      if ("error" in seg) return seg
      segments.push(seg)
      i = end + 1
      continue
    }

    // Leading bare key, e.g. "data.items"
    if (segments.length === 0 && KEY_CHARS.test(c!)) {
      const start = i
      while (i < s.length && KEY_CHARS.test(s[i]!)) i++
      segments.push({ kind: "key", key: s.slice(start, i) })
      continue
    }

    return { error: `Unexpected character '${c}' at position ${i} in '${input}'` }
  }

  if (segments.length === 0) return { error: `Empty selector` }
  return { segments }
}

function resolve(value: unknown, segments: PathSegment[], pathSoFar: string): { value: unknown } | { error: string } {
  if (segments.length === 0) return { value }
  const [seg, ...rest] = segments

  switch (seg!.kind) {
    case "key": {
      if (!isPlainObject(value)) {
        return {
          error: `Cannot read key '${seg!.key}' at '${pathSoFar || "(root)"}': value is ${typeName(value)}, not an object`,
        }
      }
      if (!Object.prototype.hasOwnProperty.call(value, seg.key)) {
        const available = Object.keys(value).slice(0, 20).join(", ")
        return {
          error: `Key '${seg.key}' not found at '${pathSoFar || "(root)"}'. Available keys: ${available || "(none)"}`,
        }
      }
      return resolve(value[seg.key], rest, `${pathSoFar}.${seg.key}`)
    }

    case "index": {
      if (!Array.isArray(value)) {
        return {
          error: `Cannot index [${seg.index}] at '${pathSoFar || "(root)"}': value is ${typeName(value)}, not an array`,
        }
      }
      const idx = seg.index < 0 ? value.length + seg.index : seg.index
      if (idx < 0 || idx >= value.length) {
        return { error: `Index ${seg.index} out of range at '${pathSoFar || "(root)"}' (array length ${value.length})` }
      }
      return resolve(value[idx], rest, `${pathSoFar}[${seg.index}]`)
    }

    case "slice": {
      if (!Array.isArray(value)) {
        return { error: `Cannot slice at '${pathSoFar || "(root)"}': value is ${typeName(value)}, not an array` }
      }
      const len = value.length
      const norm = (n: number | null, dflt: number): number => {
        if (n === null) return dflt
        return n < 0 ? Math.max(0, len + n) : Math.min(n, len)
      }
      const sliced = value.slice(norm(seg.start, 0), norm(seg.end, len))
      return resolve(sliced, rest, `${pathSoFar}[${seg.start ?? ""}:${seg.end ?? ""}]`)
    }

    case "wild": {
      let items: unknown[]
      if (Array.isArray(value)) items = value
      else if (isPlainObject(value)) items = Object.values(value)
      else {
        return {
          error: `Cannot use [*] at '${pathSoFar || "(root)"}': value is ${typeName(value)}, not an array or object`,
        }
      }
      // Map the rest of the path over each element. Tolerate per-element
      // failures (heterogeneous arrays with optional fields are common) by
      // null-filling them, but if nothing matched, surface the error so the
      // model gets feedback on a wholesale-wrong path rather than all-null.
      const out: unknown[] = []
      let firstError: { error: string } | null = null
      let matched = 0
      for (const item of items) {
        const r = resolve(item, rest, `${pathSoFar}[*]`)
        if ("error" in r) {
          if (!firstError) firstError = r
          out.push(null)
        } else {
          matched++
          out.push(r.value)
        }
      }
      if (matched === 0 && firstError) return firstError
      return { value: out }
    }
  }
}

/**
 * Apply a minimal jq-like path to a JSON value. Supports `.key`, `["quoted key"]`,
 * `[index]` (negative allowed), `[start:end]` slices, and `[*]` wildcards.
 * Returns the selected value or an actionable error.
 */
export function applySelect(value: unknown, select: string): { value: unknown } | { error: string } {
  const parsed = parsePath(select)
  if ("error" in parsed) return parsed
  return resolve(value, parsed.segments, "")
}
