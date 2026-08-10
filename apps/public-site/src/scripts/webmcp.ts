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
   headed by a `*Source: …*` line, which is the unit worth returning. */
async function searchDocs(args: Record<string, unknown>): Promise<ToolResult> {
  const query = String(args.query ?? "").trim()
  if (!query) return text("Provide a query.")

  const terms = query.toLowerCase().split(/\s+/)
  const sections = (await load("/llms-full.txt")).split(/\n---\n/)
  const scored = sections
    .map((section) => {
      const haystack = section.toLowerCase()
      return { section, score: terms.filter((t) => haystack.includes(t)).length }
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)

  if (scored.length === 0) {
    return text(`Nothing in the Threa docs matched "${query}". The full docs are at https://threa.io/llms-full.txt.`)
  }
  return text(scored.map((s) => s.section.trim()).join("\n\n---\n\n"))
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
      "Search the Threa developer documentation — authentication, API reference, versioning, message markdown, operations, the CLI and MCP server, and worked recipes. Returns the matching sections verbatim.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "What to look for, e.g. 'api key scopes' or 'search memos'." },
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
