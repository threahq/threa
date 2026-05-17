#!/usr/bin/env bun
/**
 * Generates an OpenAPI 3.0 spec from the public API route registry.
 *
 * Usage:
 *   bun apps/backend/scripts/generate-api-docs.ts          # write docs/public-api/openapi.json
 *   bun apps/backend/scripts/generate-api-docs.ts --check  # exit 1 if spec would change (CI / pre-commit)
 */
import { z } from "zod"
import { resolve, dirname } from "path"
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs"
import * as prettier from "prettier"
import { PUBLIC_API_ROUTES, errorSchema } from "../src/features/public-api/routes"
import { API_KEY_ELIGIBLE_PICKER_SCOPES } from "@threa/types"

const REPO_ROOT = resolve(import.meta.dirname!, "../../..")
const OUTPUT_PATH = resolve(REPO_ROOT, "docs/public-api/openapi.json")
const CHECK_MODE = process.argv.includes("--check")

// ---------------------------------------------------------------------------
// Zod → JSON Schema conversion
// ---------------------------------------------------------------------------

/**
 * Strip verbose regex patterns from date-time fields — `format: "date-time"` is
 * sufficient for OpenAPI consumers and the Zod v4 leap-year regex is unreadable noise.
 */
function stripDateTimePatterns(obj: unknown): unknown {
  if (Array.isArray(obj)) return obj.map(stripDateTimePatterns)
  if (obj !== null && typeof obj === "object") {
    const record = obj as Record<string, unknown>
    if (record.format === "date-time") {
      const { pattern: _, ...rest } = record
      return Object.fromEntries(Object.entries(rest).map(([k, v]) => [k, stripDateTimePatterns(v)]))
    }
    return Object.fromEntries(Object.entries(record).map(([k, v]) => [k, stripDateTimePatterns(v)]))
  }
  return obj
}

function zodToJsonSchema(schema: z.ZodType): Record<string, unknown> {
  if (schema instanceof z.ZodVoid) {
    return {}
  }
  const raw = z.toJSONSchema(schema, { unrepresentable: "any" }) as Record<string, unknown>
  return stripDateTimePatterns(raw) as Record<string, unknown>
}

// ---------------------------------------------------------------------------
// Build OpenAPI 3.0 document
// ---------------------------------------------------------------------------

function buildSpec() {
  const paths: Record<string, Record<string, unknown>> = {}

  for (const route of PUBLIC_API_ROUTES) {
    const pathKey = route.path
    if (!paths[pathKey]) paths[pathKey] = {}

    const operation: Record<string, unknown> = {
      operationId: route.operationId,
      summary: route.summary,
      tags: route.tags,
    }

    if (route.description) {
      operation.description = route.description
    }

    // Security — list required scopes
    operation.security = [{ apiKey: route.scopes }]

    // Parameters (path + query)
    const parameters: unknown[] = []

    if (route.parameters) {
      for (const p of route.parameters) {
        parameters.push({
          name: p.name,
          in: p.in,
          required: p.required,
          schema: p.schema,
          description: p.description,
        })
      }
    }

    // Query parameters from Zod schema
    if (route.requestSchema && route.requestIn === "query") {
      const jsonSchema = zodToJsonSchema(route.requestSchema)
      const props = (jsonSchema as any).properties ?? {}
      const required = new Set((jsonSchema as any).required ?? [])

      for (const [name, propSchema] of Object.entries(props)) {
        parameters.push({
          name,
          in: "query",
          required: required.has(name),
          schema: propSchema,
        })
      }
    }

    if (parameters.length > 0) {
      operation.parameters = parameters
    }

    // Request body (POST/PATCH)
    if (route.requestSchema && route.requestIn === "body") {
      operation.requestBody = {
        required: true,
        content: {
          "application/json": {
            schema: zodToJsonSchema(route.requestSchema),
          },
        },
      }
    }

    // Responses
    const successStatus = String(route.successStatus ?? 200)
    const responses: Record<string, unknown> = {}

    if (successStatus === "204") {
      responses["204"] = { description: "No content" }
    } else {
      const responseJsonSchema = zodToJsonSchema(route.responseSchema)
      responses[successStatus] = {
        description: "Successful response",
        content: {
          "application/json": {
            schema: responseJsonSchema,
          },
        },
      }
    }

    // Error responses
    const errorJsonSchema = zodToJsonSchema(errorSchema)
    responses["400"] = {
      description: "Validation error",
      content: { "application/json": { schema: errorJsonSchema } },
    }
    responses["401"] = { description: "Missing or invalid API key" }
    responses["403"] = { description: "Insufficient permissions or inaccessible resource" }

    if (route.canReturn404) {
      responses["404"] = { description: "Resource not found" }
    }

    operation.responses = responses

    paths[pathKey][route.method] = operation
  }

  return {
    openapi: "3.0.3",
    info: {
      title: "Threa Public API",
      version: "1.0.0",
      description: [
        "The Threa Public API lets you programmatically read and write messages, list streams, search, and more.",
        "",
        "## Authentication",
        "",
        "All requests require a Bearer token in the `Authorization` header:",
        "",
        "```",
        "Authorization: Bearer thr_your_api_key_here",
        "```",
        "",
        "API keys are created by **workspace admins** in the Threa app under **Settings > API Keys**.",
        "Each key is scoped to a workspace and granted specific permissions (scopes).",
        "",
        "## Scopes",
        "",
        "API keys are granted specific scopes that control access:",
        "",
        ...API_KEY_ELIGIBLE_PICKER_SCOPES.map((p) => `- \`${p.slug}\` — ${p.description}`),
        "",
        "## Rate Limits",
        "",
        "Requests are rate-limited per workspace and per API key. Rate limit headers are included in responses.",
        "",
        "## Pagination",
        "",
        "List endpoints return paginated results with `hasMore` and `cursor` fields.",
        "Pass the `cursor` value as the `after` query parameter to fetch the next page.",
      ].join("\n"),
    },
    servers: [
      {
        url: "https://app.threa.io",
        description: "Production",
      },
    ],
    security: [{ apiKey: [] }],
    paths,
    components: {
      securitySchemes: {
        apiKey: {
          type: "http",
          scheme: "bearer",
          description: "API key created by a workspace admin in Settings > API Keys. Prefix: `thr_`.",
        },
      },
    },
    tags: [
      { name: "Streams", description: "List and inspect streams (channels, scratchpads, threads)" },
      { name: "Messages", description: "Read, send, update, and delete messages" },
      { name: "Memos", description: "Search preserved workspace knowledge and inspect memo provenance" },
      { name: "Attachments", description: "Search attachments, inspect extracted content, and fetch download URLs" },
      { name: "Users", description: "List workspace users" },
    ],
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const spec = buildSpec()
const prettierConfig = await prettier.resolveConfig(OUTPUT_PATH)
const json = await prettier.format(JSON.stringify(spec), {
  ...prettierConfig,
  filepath: OUTPUT_PATH,
})

if (CHECK_MODE) {
  if (!existsSync(OUTPUT_PATH)) {
    console.error(`OpenAPI spec not found at ${OUTPUT_PATH}. Run: bun apps/backend/scripts/generate-api-docs.ts`)
    process.exit(1)
  }
  const existing = readFileSync(OUTPUT_PATH, "utf-8")
  if (existing !== json) {
    console.error("OpenAPI spec is out of date. Run: bun apps/backend/scripts/generate-api-docs.ts")
    process.exit(1)
  }
  console.log("OpenAPI spec is up to date.")
  process.exit(0)
}

mkdirSync(dirname(OUTPUT_PATH), { recursive: true })
writeFileSync(OUTPUT_PATH, json)
console.log(`Wrote OpenAPI spec to ${OUTPUT_PATH}`)
