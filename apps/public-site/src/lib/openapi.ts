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

/* ---------- Example responses ----------
   The spec carries no example values, so the reference synthesizes realistic
   ones from field names: prefixed-ULID ids, ISO timestamps, and content drawn
   from the same auth-refactor story the marketing pages tell. Illustrative,
   not contractual — the schema tables beside them stay the contract. */

const ULID = "01jd2q4z8kxw9v7r3m5t8n"

function prefixedId(noun: string): string {
  const n = noun.toLowerCase()
  if (n.includes("stream") || n.includes("channel")) return `stream_${ULID}`
  if (n.includes("message")) return `msg_${ULID}`
  if (n.includes("memo")) return `memo_${ULID}`
  if (n.includes("user") || n.includes("author") || n.includes("member") || n.includes("owner")) return `usr_${ULID}`
  if (n.includes("workspace")) return `ws_${ULID}`
  if (n.includes("attachment") || n.includes("file")) return `attach_${ULID}`
  if (n.includes("invocation")) return `inv_${ULID}`
  if (n.includes("bot")) return `bot_${ULID}`
  return `${n || "id"}_${ULID}`
}

function exampleString(name: string, schema: JsonSchema, hint: string): string {
  if (schema.enum && schema.enum.length) return String(schema.enum[0])
  if (schema.format === "date-time") return "2026-03-12T11:42:00.000Z"
  const n = name.toLowerCase()
  if (n === "id") return prefixedId(hint)
  if (n.endsWith("id")) {
    if (n.startsWith("client")) return "ci-deploy-2.4.1"
    if (n.startsWith("instance")) return "my-laptop-1"
    // sourceMessageId / parentStreamId / rootStreamId → the bare entity noun.
    return prefixedId(n.slice(0, -2).replace(/^(source|parent|root)/, ""))
  }
  if (n.includes("email")) return "maya@acme.dev"
  if (n.includes("slug")) return "api-v3"
  if (n.includes("displayname") || n === "name") {
    if (n.includes("author") || n.includes("user") || hint.includes("user") || hint.includes("bot")) {
      return "Maya Reyes"
    }
    return "api-v3"
  }
  if (n.includes("sequence")) return "412"
  if (n.includes("title")) return "Auth refactor held pending token-rotation review"
  if (n.includes("abstract") || n.includes("summary") || n.includes("description")) {
    return "Jordan asked to pause the v3 auth boundary until the rotation flow is reviewed."
  }
  if (n.includes("content") || n.includes("markdown") || n.includes("prompt") || n.includes("text")) {
    return "Picking the auth refactor back up next sprint."
  }
  if (n.includes("query")) return "auth refactor"
  if (n.includes("url")) return "https://files.threa.io/attachments/rotation-flow.png"
  if (n.includes("token")) return "clm_7f3kq9w2…"
  if (n.includes("filename")) return "rotation-flow.png"
  if (n.includes("mime")) return "image/png"
  if (n.includes("tag")) return "api-v3"
  if (n.includes("knowledgetype")) return "decision"
  if (n.includes("role")) return "member"
  if (n.includes("kind")) return "user"
  if (n.includes("visibility")) return "open"
  if (n.includes("status") || n.includes("state")) return "available"
  return "…"
}

function exampleNumber(name: string): number {
  const n = name.toLowerCase()
  if (n.includes("limit")) return 20
  if (n.includes("count") || n.includes("total")) return 2
  if (n.includes("sequence")) return 412
  if (n.includes("size") || n.includes("bytes")) return 48213
  if (n.includes("score") || n.includes("similarity")) return 0.87
  if (n.includes("ttl") || n.includes("seconds")) return 120
  if (n.includes("ms") || n.includes("duration")) return 1240
  return 1
}

function exampleResponseValue(name: string, schema: JsonSchema, hint: string, depth: number): unknown {
  const variants = schema.anyOf ?? schema.oneOf
  if (variants && variants.length) {
    // Nullable cursors read most naturally as their resting state.
    if (name.toLowerCase().includes("cursor")) return null
    const nonNull = variants.find((v) => v.type !== "null") ?? variants[0]
    return exampleResponseValue(name, nonNull, hint, depth)
  }
  switch (schema.type) {
    case "string":
      return exampleString(name, schema, hint)
    case "integer":
    case "number":
      return exampleNumber(name)
    case "boolean":
      if (schema.default !== undefined) return schema.default
      return name.toLowerCase() !== "hasmore"
    case "array":
      return schema.items ? [exampleResponseValue(name, schema.items, hint, depth)] : []
    case "object":
      return exampleResponse(schema, hint, depth + 1)
    default:
      return null
  }
}

/* A full example object for a response schema: every property, arrays as one
   item, nested objects to a sane depth. `hint` names the entity (from the
   endpoint path) so bare `id` fields get the right prefix. */
export function exampleResponse(schema: JsonSchema | undefined, hint = "", depth = 0): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (!schema?.properties || depth > 4) return out
  for (const [name, prop] of Object.entries(schema.properties)) {
    out[name] = exampleResponseValue(name, prop, hint, depth)
  }
  return out
}
