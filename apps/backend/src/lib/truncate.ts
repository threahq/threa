/**
 * Cuts by code point: a UTF-16 cut can split an emoji into a lone surrogate,
 * which Postgres rejects in JSON and TEXT parameters.
 */
export function truncateCodePoints(text: string, max: number, suffix = ""): string {
  if (text.length <= max) return text
  const codePoints = Array.from(text)
  if (codePoints.length <= max) return text
  return `${codePoints.slice(0, max).join("")}${suffix}`
}
