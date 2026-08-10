/*
 * WebMCP: expose the site's own reference material as tools, so an agent
 * browsing threa.io can answer a question about the API without crawling the
 * docs. Both tools are read-only and fetch the artifacts the site already
 * publishes — llms-full.txt and openapi.json — so there is nothing here that a
 * plain fetch could not do; the tools just save the agent the discovery step.
 *
 * The API is behind a flag in Chrome and absent everywhere else, hence the
 * capability check rather than a polyfill.
 */

interface ToolResult {
  content: { type: "text"; text: string }[]
}

interface ToolDefinition {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  execute: (args: Record<string, unknown>) => Promise<ToolResult>
}

interface ModelContext {
  registerTool?: (tool: ToolDefinition) => unknown
  provideContext?: (context: { tools: ToolDefinition[] }) => unknown
}

const text = (value: string): ToolResult => ({ content: [{ type: "text", text: value }] })

/* One fetch per artifact per page load; the tools are usually called in a row. */
const cache = new Map<string, Promise<string>>()
function load(path: string): Promise<string> {
  const hit = cache.get(path)
  if (hit) return hit
  const pending = fetch(path).then((res) => {
    if (!res.ok) throw new Error(`${path} responded ${res.status}`)
    return res.text()
  })
  cache.set(path, pending)
  return pending
}

/* llms-full.txt is the docs pages concatenated, separated by `---` lines and
   headed by a `*Source: …*` line, which is the unit worth returning.

   Literal substring, not tokens: splitting a query on whitespace and ranking by
   how many pieces appear is a relevance judgment made by a heuristic that only
   holds for space-delimited languages (INV-54), and a static page has no model
   to make it properly. A miss returns the page list so the caller can pick one
   itself rather than being told nothing. */
async function searchDocs(args: Record<string, unknown>): Promise<ToolResult> {
  const query = String(args.query ?? "").trim()
  if (!query) return text("Provide a query.")

  const needle = query.toLowerCase()
  const sections = (await load("/llms-full.txt")).split(/\n---\n/)
  const hits = sections.filter((section) => section.toLowerCase().includes(needle)).slice(0, 3)

  if (hits.length === 0) {
    const pages = sections.map((s) => s.match(/^\*Source: (\S+)\*/m)?.[1]).filter(Boolean)
    return text(
      `No section of the Threa docs contains "${query}" literally.\n\nPages available:\n${pages
        .map((p) => `- ${p}`)
        .join("\n")}\n\nAll of them in one fetch: https://threa.io/llms-full.txt`
    )
  }
  return text(hits.map((section) => section.trim()).join("\n\n---\n\n"))
}

interface OpenApiOperation {
  summary?: string
  description?: string
}

async function listEndpoints(args: Record<string, unknown>): Promise<ToolResult> {
  const filter = String(args.filter ?? "")
    .trim()
    .toLowerCase()
  const spec = JSON.parse(await load("/openapi.json")) as {
    paths: Record<string, Record<string, OpenApiOperation>>
  }

  const lines: string[] = []
  for (const [path, operations] of Object.entries(spec.paths)) {
    for (const [method, operation] of Object.entries(operations)) {
      const line = `${method.toUpperCase()} ${path} — ${operation.summary ?? operation.description ?? ""}`.trim()
      if (!filter || line.toLowerCase().includes(filter)) lines.push(line)
    }
  }

  if (lines.length === 0) return text(`No Threa API endpoint matched "${filter}".`)
  return text(
    `${lines.sort().join("\n")}\n\nFull contract, including request and response schemas: https://threa.io/openapi.json`
  )
}

const TOOLS: ToolDefinition[] = [
  {
    name: "search_threa_docs",
    description:
      "Find a literal string in the Threa developer documentation — authentication, API reference, versioning, message markdown, operations, the CLI and MCP server, and worked recipes. Returns each page containing the string verbatim, or the page list when nothing contains it. Case-insensitive substring, not a ranked search: pass a phrase that would appear in the docs, such as an endpoint path or a scope name.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "The exact string to look for, e.g. 'memos:read' or '/messages/find-by-metadata'.",
        },
      },
      required: ["query"],
    },
    execute: searchDocs,
  },
  {
    name: "list_threa_api_endpoints",
    description:
      "List the endpoints of the Threa public REST API with their summaries, optionally filtered by a substring such as 'memos' or 'delegation'.",
    inputSchema: {
      type: "object",
      properties: {
        filter: { type: "string", description: "Optional substring to match against method, path, and summary." },
      },
    },
    execute: listEndpoints,
  },
]

const modelContext = (navigator as Navigator & { modelContext?: ModelContext }).modelContext
if (modelContext) {
  if (typeof modelContext.registerTool === "function") {
    for (const tool of TOOLS) modelContext.registerTool(tool)
  } else if (typeof modelContext.provideContext === "function") {
    modelContext.provideContext({ tools: TOOLS })
  }
}
