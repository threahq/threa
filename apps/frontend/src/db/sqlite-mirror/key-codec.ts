import type { DBCoreKeyRange } from "dexie"

const TAG_ARRAY_END = 0x00
const TAG_NUMBER = 0x10
const TAG_DATE = 0x20
const TAG_STRING = 0x30
const TAG_BINARY = 0x40
const TAG_ARRAY = 0x50

const RANGE_TYPE_EQUAL = 1
const RANGE_TYPE_ANY = 3
const RANGE_TYPE_NEVER = 4

export interface EncodedRange {
  lower?: Uint8Array
  lowerOpen: boolean
  upper?: Uint8Array
  upperOpen: boolean
}

function pushNumber(out: number[], value: number): void {
  if (Number.isNaN(value)) throw new TypeError("NaN is not a valid IndexedDB key")
  const view = new DataView(new ArrayBuffer(8))
  view.setFloat64(0, value === 0 ? 0 : value)
  const negative = (view.getUint8(0) & 0x80) !== 0
  for (let i = 0; i < 8; i++) {
    const byte = view.getUint8(i)
    const positive = i === 0 ? byte ^ 0x80 : byte
    out.push(negative ? ~byte & 0xff : positive)
  }
}

// 0x00 bytes become 0x00 0xFF so the 0x00 0x01 terminator sorts below every continuation.
function pushEscapedBytes(out: number[], bytes: ArrayLike<number>): void {
  for (let i = 0; i < bytes.length; i++) {
    out.push(bytes[i])
    if (bytes[i] === 0) out.push(0xff)
  }
  out.push(0x00, 0x01)
}

function pushKey(out: number[], key: unknown): void {
  if (typeof key === "number") {
    out.push(TAG_NUMBER)
    pushNumber(out, key)
  } else if (key instanceof Date) {
    out.push(TAG_DATE)
    pushNumber(out, key.getTime())
  } else if (typeof key === "string") {
    out.push(TAG_STRING)
    const units: number[] = []
    for (let i = 0; i < key.length; i++) {
      const unit = key.charCodeAt(i)
      units.push(unit >> 8, unit & 0xff)
    }
    pushEscapedBytes(out, units)
  } else if (key instanceof ArrayBuffer) {
    out.push(TAG_BINARY)
    pushEscapedBytes(out, new Uint8Array(key))
  } else if (ArrayBuffer.isView(key)) {
    out.push(TAG_BINARY)
    pushEscapedBytes(out, new Uint8Array(key.buffer, key.byteOffset, key.byteLength))
  } else if (Array.isArray(key)) {
    out.push(TAG_ARRAY)
    for (const element of key) pushKey(out, element)
    out.push(TAG_ARRAY_END)
  } else {
    throw new TypeError("Value is not a valid IndexedDB key")
  }
}

export function encodeKey(key: IDBValidKey): Uint8Array {
  const out: number[] = []
  pushKey(out, key)
  return Uint8Array.from(out)
}

interface Reader {
  bytes: Uint8Array
  pos: number
}

function readNumber(reader: Reader): number {
  const view = new DataView(new ArrayBuffer(8))
  const negative = (reader.bytes[reader.pos] & 0x80) === 0
  for (let i = 0; i < 8; i++) {
    const byte = reader.bytes[reader.pos + i]
    const positive = i === 0 ? byte ^ 0x80 : byte
    view.setUint8(i, negative ? ~byte & 0xff : positive)
  }
  reader.pos += 8
  return view.getFloat64(0)
}

function readEscapedBytes(reader: Reader): Uint8Array<ArrayBuffer> {
  const out: number[] = []
  const { bytes } = reader
  for (;;) {
    const byte = bytes[reader.pos++]
    if (byte !== 0) {
      out.push(byte)
      continue
    }
    if (bytes[reader.pos++] === 0x01) return Uint8Array.from(out)
    out.push(0)
  }
}

function readKey(reader: Reader): IDBValidKey {
  const tag = reader.bytes[reader.pos++]
  switch (tag) {
    case TAG_NUMBER:
      return readNumber(reader)
    case TAG_DATE:
      return new Date(readNumber(reader))
    case TAG_STRING: {
      const units = readEscapedBytes(reader)
      let text = ""
      for (let i = 0; i < units.length; i += 2) text += String.fromCharCode((units[i] << 8) | units[i + 1])
      return text
    }
    case TAG_BINARY:
      return readEscapedBytes(reader).buffer
    case TAG_ARRAY: {
      const elements: IDBValidKey[] = []
      while (reader.bytes[reader.pos] !== TAG_ARRAY_END) elements.push(readKey(reader))
      reader.pos++
      return elements
    }
    default:
      throw new Error(`Unknown key tag ${tag}`)
  }
}

/** The key `encodeKey` encoded, as IndexedDB returns it: binary keys come back as ArrayBuffer. */
export function decodeKey(bytes: Uint8Array): IDBValidKey {
  return readKey({ bytes, pos: 0 })
}

export function keyId(key: Uint8Array): string {
  return key.join(",")
}

export function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const shared = Math.min(a.length, b.length)
  for (let i = 0; i < shared; i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1
  }
  return Math.sign(a.length - b.length)
}

export function encodeRange(range: DBCoreKeyRange): EncodedRange {
  if (range.type === RANGE_TYPE_ANY) return { lowerOpen: false, upperOpen: false }
  if (range.type === RANGE_TYPE_NEVER) {
    const point = encodeKey(0)
    return { lower: point, lowerOpen: true, upper: point, upperOpen: true }
  }
  if (range.type === RANGE_TYPE_EQUAL) {
    const point = encodeKey(range.lower)
    return { lower: point, lowerOpen: false, upper: point, upperOpen: false }
  }
  return {
    lower: range.lower === undefined ? undefined : encodeKey(range.lower),
    lowerOpen: range.lowerOpen ?? false,
    upper: range.upper === undefined ? undefined : encodeKey(range.upper),
    upperOpen: range.upperOpen ?? false,
  }
}

export function isKeyInRange(key: Uint8Array, range: EncodedRange): boolean {
  if (range.lower) {
    const cmp = compareBytes(key, range.lower)
    if (cmp < 0 || (cmp === 0 && range.lowerOpen)) return false
  }
  if (range.upper) {
    const cmp = compareBytes(key, range.upper)
    if (cmp > 0 || (cmp === 0 && range.upperOpen)) return false
  }
  return true
}
