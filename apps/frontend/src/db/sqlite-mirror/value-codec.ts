const TAG = "$t"

export class UnmirrorableValueError extends Error {
  constructor(description: string) {
    super(`Value cannot be mirrored to SQLite: ${description}`)
    this.name = "UnmirrorableValueError"
  }
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json }

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ""
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return btoa(binary)
}

function base64ToBytes(encoded: string): Uint8Array {
  const binary = atob(encoded)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

function isPlainObject(value: object): value is Record<string, unknown> {
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

function toJson(value: unknown): Json {
  if (value === undefined) return { [TAG]: "undefined" }
  if (value === null || typeof value === "boolean" || typeof value === "string") return value
  if (typeof value === "number") {
    if (Number.isFinite(value) && !Object.is(value, -0)) return value
    return { [TAG]: "number", v: String(value) === "0" ? "-0" : String(value) }
  }
  if (typeof value !== "object") throw new UnmirrorableValueError(typeof value)
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new UnmirrorableValueError("invalid Date")
    return { [TAG]: "date", v: value.getTime() }
  }
  if (value instanceof Uint8Array) return { [TAG]: "bytes", v: bytesToBase64(value) }
  if (value instanceof ArrayBuffer) return { [TAG]: "buffer", v: bytesToBase64(new Uint8Array(value)) }
  if (Array.isArray(value)) return value.map(toJson)
  if (!isPlainObject(value)) throw new UnmirrorableValueError(value.constructor?.name ?? "object")
  const entries = Object.entries(value).map(([k, v]): [string, Json] => [k, toJson(v)])
  const encoded = Object.fromEntries(entries)
  return TAG in value ? { [TAG]: "object", v: encoded } : encoded
}

function fromJson(json: Json): unknown {
  if (json === null || typeof json !== "object") return json
  if (Array.isArray(json)) return json.map(fromJson)
  const tag = json[TAG]
  if (tag === undefined) return decodeEntries(json)
  switch (tag) {
    case "undefined":
      return undefined
    case "number":
      return Number(json.v)
    case "date":
      return new Date(json.v as number)
    case "bytes":
      return base64ToBytes(json.v as string)
    case "buffer":
      return base64ToBytes(json.v as string).buffer
    case "object":
      return decodeEntries(json.v as { [key: string]: Json })
    default:
      throw new Error(`Unknown mirrored value tag: ${String(tag)}`)
  }
}

function decodeEntries(json: { [key: string]: Json }): Record<string, unknown> {
  return Object.fromEntries(Object.entries(json).map(([k, v]) => [k, fromJson(v)]))
}

export function encodeValue(value: unknown): string {
  return JSON.stringify(toJson(value))
}

export function decodeValue(encoded: string): unknown {
  return fromJson(JSON.parse(encoded) as Json)
}
