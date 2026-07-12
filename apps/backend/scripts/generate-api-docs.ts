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
import { API_VERSIONS, CURRENT_API_VERSION, VERSION_CHANGES } from "../src/features/public-api/versions"
import { API_KEY_ELIGIBLE_PICKER_SCOPES } from "@threa/types"

const REPO_ROOT = resolve(import.meta.dirname!, "../../..")
const OUTPUT_PATH = resolve(REPO_ROOT, "docs/public-api/openapi.json")
const CHANGELOG_PATH = resolve(REPO_ROOT, "docs/public-api/CHANGELOG.md")
const CHECK_MODE = process.argv.includes("--check")

// The epoch version predates the version-change machinery, so it has no module
// in VERSION_CHANGES; seed its changelog entry here.
const EPOCH_VERSION = API_VERSIONS[0]
const EPOCH_CHANGELOG_DESCRIPTION = "Initial versioned API."

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

// Tag order + descriptions for the reference. Every tag a route declares must
// have an entry here. The spec emits the entries that are actually in use, so a
// newly added group surfaces in the rendered reference without editing the docs
// site; a route that introduces an undescribed tag fails the build loudly
// (INV-11) instead of shipping a group with no heading.
const TAG_DEFS: { name: string; description: string }[] = [
  { name: "Identity", description: "Confirm who a key belongs to and list the bots you own." },
  { name: "Streams", description: "List and inspect streams (channels, scratchpads, threads)" },
  { name: "Messages", description: "Read, send, update, and delete messages" },
  { name: "Memos", description: "Search preserved workspace knowledge and inspect memo provenance" },
  { name: "Attachments", description: "Search attachments, inspect extracted content, and fetch download URLs" },
  { name: "Users", description: "List workspace users" },
  { name: "Labels", description: "List, create, edit, archive, join, and apply workspace labels" },
  {
    name: "Bot runtimes",
    description: "Register a runtime and keep its presence alive so it can be assigned work.",
  },
  {
    name: "Bot invocations",
    description: "Claim, renew, step through, complete, or fail the work a bot is summoned to do.",
  },
  {
    name: "Delegations",
    description:
      "Close the loop on delegated tasks: your local agent lists the open queue, claims a task, reports progress, and completes it with a result posted back to the stream.",
  },
]

function buildTags() {
  const used = new Set<string>()
  for (const route of PUBLIC_API_ROUTES) for (const tag of route.tags ?? []) used.add(tag)
  const undescribed = [...used].filter((tag) => !TAG_DEFS.some((d) => d.name === tag))
  if (undescribed.length > 0) {
    throw new Error(
      `Public API routes declare tags with no description (add them to TAG_DEFS in generate-api-docs.ts): ${undescribed.join(", ")}`
    )
  }
  return TAG_DEFS.filter((d) => used.has(d.name))
}

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

    // Parameters (path + query). Threa-Version leads every operation via a
    // shared component so the versioning header is documented once and referenced
    // everywhere.
    const parameters: unknown[] = [{ $ref: "#/components/parameters/ThreaVersion" }]

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
          // zod-to-json-schema lists defaulted fields as required (the parsed
          // OUTPUT always has them), but for a request parameter a default
          // means the caller may omit it.
          required: required.has(name) && (propSchema as { default?: unknown }).default === undefined,
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

    if (route.requestIn === "multipart") {
      operation.requestBody = {
        required: true,
        content: {
          "multipart/form-data": {
            schema: {
              type: "object",
              required: ["file"],
              properties: {
                file: { type: "string", format: "binary" },
              },
            },
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

    if (route.canReturn409) {
      responses["409"] = {
        description: "Conflict — the resource is not in the state the operation requires",
        content: { "application/json": { schema: errorJsonSchema } },
      }
    }

    operation.responses = responses

    paths[pathKey][route.method] = operation
  }

  return {
    openapi: "3.0.3",
    info: {
      title: "Threa Public API",
      version: CURRENT_API_VERSION,
      description: [
        "The Threa Public API lets you programmatically read and write messages, list streams, search, and more.",
        "",
        "## Authentication",
        "",
        "All requests require a Bearer token in the `Authorization` header:",
        "",
        "```",
        "Authorization: Bearer threa_uk_your_api_key_here",
        "```",
        "",
        "Keys use two prefixes. A **personal access key** (`threa_uk_…`) carries a member's own",
        "identity and access; any member creates one in the Threa app under **Settings > API keys**.",
        "A **bot key** (`threa_bk_…`) belongs to a bot with its own identity in the workspace —",
        "either a personal bot or a shared workspace bot — and is minted from the bot's settings",
        "(personal bots by their owner, shared bots by an admin).",
        "Each key is scoped to a workspace and granted specific permissions (scopes).",
        "",
        "Human-readable docs: https://threa.io/developers (agent-friendly mirror: https://threa.io/llms.txt).",
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
      parameters: {
        ThreaVersion: {
          name: "Threa-Version",
          in: "header",
          required: false,
          schema: { type: "string", enum: [...API_VERSIONS] },
          description: [
            "Selects the dated API version for this request. Each API key is pinned to a",
            "version when it is minted, and that pin applies when the header is absent. Send",
            "this header to override the pin per request (a valid header always wins). The",
            "value must be an exact member of the enum; an unknown or malformed value returns",
            "400 with code INVALID_API_VERSION and the known versions in the error. Every",
            "response echoes the resolved version in a Threa-Version response header.",
          ].join(" "),
        },
      },
      securitySchemes: {
        apiKey: {
          type: "http",
          scheme: "bearer",
          description:
            "Personal access key (`threa_uk_…`, created in Settings > API keys) or bot key (`threa_bk_…`, minted from a bot's settings).",
        },
      },
    },
    tags: buildTags(),
  }
}

// ---------------------------------------------------------------------------
// Changelog
// ---------------------------------------------------------------------------

// Newest version first, with the epoch (which has no change module) last.
function buildChangelog(): string {
  const entries = [...VERSION_CHANGES]
    .sort((a, b) => (a.version < b.version ? 1 : -1))
    .map((change) => {
      const ops = [...change.operations].sort()
      const affected = ops.length > 0 ? `\n\nAffected operations: ${ops.join(", ")}` : ""
      return `## ${change.version}\n\n${change.description}${affected}`
    })
  entries.push(`## ${EPOCH_VERSION}\n\n${EPOCH_CHANGELOG_DESCRIPTION}`)
  return [
    "# Threa Public API changelog",
    "",
    "Generated from the version-change modules. Do not edit by hand.",
    "",
    entries.join("\n\n"),
    "",
  ].join("\n")
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
const changelog = await prettier.format(buildChangelog(), {
  ...prettierConfig,
  filepath: CHANGELOG_PATH,
})

const outputs = [
  { path: OUTPUT_PATH, contents: json, label: "OpenAPI spec" },
  { path: CHANGELOG_PATH, contents: changelog, label: "changelog" },
]

if (CHECK_MODE) {
  for (const { path, contents, label } of outputs) {
    if (!existsSync(path)) {
      console.error(`${label} not found at ${path}. Run: bun apps/backend/scripts/generate-api-docs.ts`)
      process.exit(1)
    }
    if (readFileSync(path, "utf-8") !== contents) {
      console.error(`${label} is out of date. Run: bun apps/backend/scripts/generate-api-docs.ts`)
      process.exit(1)
    }
  }
  console.log("OpenAPI spec and changelog are up to date.")
  process.exit(0)
}

for (const { path, contents, label } of outputs) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, contents)
  console.log(`Wrote ${label} to ${path}`)
}
