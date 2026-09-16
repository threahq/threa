/**
 * Exact USD arithmetic shared by the spending ledger and the provider
 * transport. Amounts travel as decimal strings (what `NUMERIC(20,8)`
 * round-trips through pg) and are compared as BigInt units of 1e-8 USD, so no
 * comparison ever passes through a float.
 */

const USD_PATTERN = /^(?:0|[1-9]\d{0,11})(?:\.\d{1,8})?$/
// Length and exponent caps keep `10n ** shift` small whatever a provider sends.
const DECIMAL_PATTERN = /^(\d{1,40})(?:\.(\d{1,40}))?(?:[eE]([+-]?\d{1,3}))?$/
const MAX_EXPONENT = 64
const UNITS_PER_USD = 100_000_000n
// NUMERIC(20,8) holds 12 integer digits.
const MAX_UNITS = 1_000_000_000_000n * UNITS_PER_USD

export class InvalidUsdError extends Error {
  readonly code = "INVALID_USD" as const
  constructor(value: string) {
    super(`Invalid USD amount: ${JSON.stringify(value)}`)
  }
}

/** Parse a non-negative decimal string into 1e-8 USD units; throws on floats, exponents, or excess precision. */
export function usdUnits(value: string): bigint {
  if (!USD_PATTERN.test(value)) throw new InvalidUsdError(value)
  const [whole, fraction = ""] = value.split(".")
  return BigInt(whole) * UNITS_PER_USD + BigInt(fraction.padEnd(8, "0"))
}

/** Canonical string for a unit amount: no trailing fractional zeros, no exponent. */
export function usdString(units: bigint): string {
  if (units < 0n || units >= MAX_UNITS) throw new InvalidUsdError(units.toString())
  const whole = units / UNITS_PER_USD
  const fraction = (units % UNITS_PER_USD).toString().padStart(8, "0").replace(/0+$/, "")
  return fraction ? `${whole}.${fraction}` : whole.toString()
}

/** Validate and canonicalise a caller-supplied amount ("1.50" → "1.5"). */
export function usd(value: string): string {
  return usdString(usdUnits(value))
}

export function compareUsd(a: string, b: string): -1 | 0 | 1 {
  const left = usdUnits(a)
  const right = usdUnits(b)
  if (left < right) return -1
  return left > right ? 1 : 0
}

/** `value = mantissa × 10^exponent`, exactly, for a non-negative plain or exponent-form decimal string. */
function parseDecimal(value: string): { mantissa: bigint; exponent: number } {
  const match = DECIMAL_PATTERN.exec(value)
  if (!match) throw new InvalidUsdError(value)
  const [, whole, fraction = "", exponent = "0"] = match
  if (Math.abs(Number(exponent)) > MAX_EXPONENT) throw new InvalidUsdError(value)
  return { mantissa: BigInt(whole + fraction), exponent: Number(exponent) - fraction.length }
}

function ceilToUnits(mantissa: bigint, exponent: number): bigint {
  const shift = exponent + 8
  return shift >= 0 ? mantissa * 10n ** BigInt(shift) : ceilDiv(mantissa, 10n ** BigInt(-shift))
}

function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  const quotient = numerator / denominator
  return quotient * denominator === numerator ? quotient : quotient + 1n
}

/**
 * Normalise a provider rate or charge, given as its exact decimal source text,
 * to a canonical USD string, rounding UP so a bound or a charge is never
 * understated. Takes no JSON number: a double has already lost digits.
 */
export function ceilUsd(value: string): string {
  const { mantissa, exponent } = parseDecimal(value)
  return usdString(ceilToUnits(mantissa, exponent))
}

/** Exact `ratePerToken × tokens`, rounded up to 1e-8 USD, for reservation bounds. */
export function usdForTokens(ratePerToken: string, tokens: number): string {
  if (!Number.isSafeInteger(tokens) || tokens < 0) throw new InvalidUsdError(`${ratePerToken} × ${tokens}`)
  const { mantissa, exponent } = parseDecimal(ratePerToken)
  return usdString(ceilToUnits(mantissa * BigInt(tokens), exponent))
}
