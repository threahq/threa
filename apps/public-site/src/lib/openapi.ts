/*
 * Small OpenAPI/JSON-Schema helpers for the hand-rendered API reference.
 *
 * The reference reads the canonical spec (docs/public-api/openapi.json) at build
 * time and renders it with the site's own components — no embedded widget. These helpers
 * flatten a JSON Schema into table rows and synthesize a minimal example body,
 * which is all the reference needs. The spec has no $ref indirection, so we
 * don't resolve references here.
 */

export type JsonSchema = {
  type?: string
  format?: string
  enum?: unknown[]
  default?: unknown
  description?: string
  properties?: Record<string, JsonSchema>
  required?: string[]
  items?: JsonSchema
  anyOf?: JsonSchema[]
  oneOf?: JsonSchema[]
  minimum?: number
  maximum?: number
  minLength?: number
  maxLength?: number
  minItems?: number
}

export interface SchemaNode {
  name: string
  type: string
  required: boolean
  description?: string
  note?: string
  children: SchemaNode[]
}

/* A human-readable type label, e.g. "string", "integer", "string[]",
   "object", "string | null". */
export function typeLabel(schema: JsonSchema | undefined): string {
  if (!schema) return "any"
  const variants = schema.anyOf ?? schema.oneOf
  if (variants && variants.length) {
    const parts = variants.map((v) => (v.type === "null" ? "null" : typeLabel(v)))
    return Array.from(new Set(parts)).join(" | ")
  }
  if (schema.type === "array") return `${typeLabel(schema.items)}[]`
  return schema.type ?? "any"
}

/* Constraints and defaults, shown beside the type. */
export function constraintNote(schema: JsonSchema | undefined): string {
  if (!schema) return ""
  const bits: string[] = []
  if (schema.enum && schema.enum.length) {
    bits.push(`one of: ${schema.enum.map((e) => String(e)).join(", ")}`)
  }
  if (schema.format) bits.push(schema.format)
  if (typeof schema.minimum === "number" && typeof schema.maximum === "number") {
    bits.push(`${schema.minimum}–${schema.maximum}`)
  } else if (typeof schema.minimum === "number") {
    bits.push(`≥ ${schema.minimum}`)
  } else if (typeof schema.maximum === "number") {
    bits.push(`≤ ${schema.maximum}`)
  }
  if (typeof schema.minLength === "number" && schema.minLength > 0) {
    bits.push(`min length ${schema.minLength}`)
  }
  if (typeof schema.maxLength === "number") bits.push(`max length ${schema.maxLength}`)
  if (schema.default !== undefined) bits.push(`default ${JSON.stringify(schema.default)}`)
  return bits.join(" · ")
}

/* Turn an object schema into a tree of property nodes, descending into nested
   objects and arrays-of-objects up to maxDepth. Each node carries its children
   so the renderer can show the payload's shape, not just an indented list. */
export function buildSchemaTree(schema: JsonSchema | undefined, maxDepth = 3): SchemaNode[] {
  const build = (s: JsonSchema | undefined, depth: number): SchemaNode[] => {
    if (!s || !s.properties) return []
    const required = new Set(s.required ?? [])
    return Object.entries(s.properties).map(([name, prop]) => {
      let children: SchemaNode[] = []
      if (depth < maxDepth) {
        if (prop.type === "object" && prop.properties) children = build(prop, depth + 1)
        else if (prop.type === "array" && prop.items?.type === "object") {
          children = build(prop.items, depth + 1)
        }
      }
      return {
        name,
        type: typeLabel(prop),
        required: required.has(name),
        description: prop.description,
        note: constraintNote(prop),
        children,
      }
    })
  }
  return build(schema, 0)
}

/* The JSON object schema a request body carries (application/json). */
export function jsonSchemaOf(content: Record<string, { schema?: JsonSchema }> | undefined): JsonSchema | undefined {
  return content?.["application/json"]?.schema
}

/* A sample value for a schema, used to seed runnable example bodies. */
function exampleValue(schema: JsonSchema | undefined): unknown {
  if (!schema) return null
  if (schema.default !== undefined) return schema.default
  if (schema.enum && schema.enum.length) return schema.enum[0]
  switch (schema.type) {
    case "string":
      return schema.format === "date-time" ? "2026-01-01T00:00:00Z" : "string"
    case "integer":
    case "number":
      return typeof schema.minimum === "number" ? schema.minimum : 1
    case "boolean":
      return schema.default ?? false
    case "array":
      return [exampleValue(schema.items)]
    case "object":
      return exampleBody(schema)
    default:
      return null
  }
}

/* A minimal example object built from a schema's required fields. Keeps runnable
   samples small and valid rather than dumping every optional field. */
export function exampleBody(schema: JsonSchema | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (!schema?.properties) return out
  const required = schema.required ?? Object.keys(schema.properties).slice(0, 3)
  for (const name of required) {
    const prop = schema.properties[name]
    if (prop) out[name] = exampleValue(prop)
  }
  return out
}
