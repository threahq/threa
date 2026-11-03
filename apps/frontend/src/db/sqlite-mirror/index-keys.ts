import { encodeKey } from "./key-codec"

const FAILURE = Symbol("failure")

// IndexedDB's "evaluate a key path on a value": only own properties count, plus the length of strings and arrays.
function evaluatePath(value: unknown, keyPath: string): unknown {
  if (keyPath === "") return value
  let current = value
  for (const identifier of keyPath.split(".")) {
    if (identifier === "length" && (typeof current === "string" || Array.isArray(current))) {
      current = current.length
    } else if (current !== null && typeof current === "object" && Object.hasOwn(current, identifier)) {
      current = (current as Record<string, unknown>)[identifier]
    } else {
      return FAILURE
    }
  }
  return current
}

function tryEncode(value: unknown): Uint8Array | null {
  try {
    return encodeKey(value as IDBValidKey)
  } catch {
    return null
  }
}

/**
 * The encoded keys IndexedDB files `value` under in an index: none when the
 * key path is missing or yields an invalid key, one per valid element for a
 * multiEntry index over an array (duplicates collapse in the index table).
 */
export function indexKeys(value: unknown, keyPath: string | string[], multiEntry: boolean): Uint8Array[] {
  const extracted = Array.isArray(keyPath)
    ? keyPath.map((path) => evaluatePath(value, path))
    : evaluatePath(value, keyPath)
  if (extracted === FAILURE || (Array.isArray(keyPath) && (extracted as unknown[]).includes(FAILURE))) return []
  if (!multiEntry || !Array.isArray(extracted)) {
    const key = tryEncode(extracted)
    return key ? [key] : []
  }
  const keys: Uint8Array[] = []
  for (let i = 0; i < extracted.length; i++) {
    const key = Object.hasOwn(extracted, i) ? tryEncode(extracted[i]) : null
    if (key) keys.push(key)
  }
  return keys
}
