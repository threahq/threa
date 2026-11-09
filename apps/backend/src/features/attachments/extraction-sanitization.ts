// Extracted text comes from model output and parsed documents, which can carry
// NUL; Postgres rejects it in both text and jsonb.
export function stripNul(value: string): string
export function stripNul(value: string | null | undefined): string | null | undefined
export function stripNul(value: string | null | undefined): string | null | undefined {
  return value == null ? value : value.replaceAll("\u0000", "")
}

// Object keys too: extracted tables can use cell text as property names.
export function toJsonWithoutNul(value: unknown): string {
  return JSON.stringify(value, (_key, propertyValue: unknown) => {
    if (typeof propertyValue === "string") return stripNul(propertyValue)
    if (propertyValue === null || typeof propertyValue !== "object" || Array.isArray(propertyValue)) {
      return propertyValue
    }
    return Object.fromEntries(Object.entries(propertyValue).map(([key, entry]) => [stripNul(key), entry]))
  })
}
