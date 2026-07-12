/*
 * Builds the API reference view model from an OpenAPI spec. Shared by the latest
 * reference page (/developers/reference) and the per-version pages
 * (/developers/reference/<version>) so both render from the same spec-derived
 * data. The spec is the single source: groups, ordering, and the sidebar
 * sections all fall out of its tags and paths.
 */

const WORKSPACE_PREFIX = "/api/v1/workspaces/{workspaceId}"
// Run configs use the playground's {{token}} form, NOT the spec's single-brace
// {workspaceId}: the playground only substitutes {{…}}, so a single-brace path
// would fire a literal "/workspaces/{workspaceId}/…" request.
const RUN_PREFIX = "/api/v1/workspaces/{{workspaceId}}"

export interface RunConfig {
  method: string
  path: string
  body?: string
}

// Runnable, read-only endpoints that need only workspace scope (no real resource
// id). Everything else shows a copyable curl without a Run button, so the docs
// never fire a state-changing call.
const RUNS: Record<string, RunConfig> = {
  getMe: { method: "GET", path: `{{baseUrl}}${RUN_PREFIX}/me` },
  listMyBots: { method: "GET", path: `{{baseUrl}}${RUN_PREFIX}/me/bots` },
  listStreams: { method: "GET", path: `{{baseUrl}}${RUN_PREFIX}/streams?type=channel&limit=20` },
  listUsers: { method: "GET", path: `{{baseUrl}}${RUN_PREFIX}/users?limit=20` },
  searchMessages: {
    method: "POST",
    path: `{{baseUrl}}${RUN_PREFIX}/messages/search`,
    body: JSON.stringify({ query: "auth", semantic: true, exact: false, limit: 5 }),
  },
  searchMemos: {
    method: "POST",
    path: `{{baseUrl}}${RUN_PREFIX}/memos/search`,
    body: JSON.stringify({ query: "auth", limit: 5 }),
  },
  searchAttachments: {
    method: "POST",
    path: `{{baseUrl}}${RUN_PREFIX}/attachments/search`,
    body: JSON.stringify({ query: "auth", limit: 5 }),
  },
}

// Worked examples that use each group's endpoints. The reference describes
// the wire; the recipe shows the task — link them so a reader who lands on
// an endpoint finds the "how would I actually use this" path immediately.
const TAG_RECIPES: Record<string, { href: string; label: string }[]> = {
  Streams: [{ href: "/developers/recipes#ci-notify", label: "Notify a stream from CI" }],
  Messages: [
    { href: "/developers/recipes#ci-notify", label: "Notify a stream from CI" },
    { href: "/developers/recipes#mirror-search", label: "Mirror a search into your own tool" },
  ],
  Memos: [{ href: "/developers/recipes#decisions", label: "Find out what was decided, and why" }],
  "Bot runtimes": [{ href: "/developers/recipes#local-agent", label: "Connect your local agent" }],
  "Bot invocations": [{ href: "/developers/recipes#local-agent", label: "Connect your local agent" }],
}

// Entity noun per tag, used to synthesize correctly-prefixed ids in example
// responses (a bare `id` under Streams renders as stream_…).
const TAG_HINT: Record<string, string> = {
  Identity: "user",
  Streams: "stream",
  Messages: "message",
  Memos: "memo",
  Attachments: "attachment",
  Users: "user",
  Labels: "label",
  "Bot runtimes": "bot",
  "Bot invocations": "invocation",
}

interface RawOp {
  operationId?: string
  tags?: string[]
  summary?: string
}

export interface ReferenceOp {
  path: string
  method: string
  op: RawOp
  anchor: string
  run?: RunConfig
  hint: string
}

export interface ReferenceGroup {
  tag: string
  slug: string
  desc?: string
  recipes?: { href: string; label: string }[]
  ops: ReferenceOp[]
}

export interface ReferenceSection {
  id: string
  label: string
  group: string
}

const shortPath = (p: string) => p.replace(WORKSPACE_PREFIX, "") || "/"

export function buildReferenceModel(spec: any): { groups: ReferenceGroup[]; sections: ReferenceSection[] } {
  // Group order and descriptions come straight from the spec's tag declaration —
  // the generator emits every tag it uses, in reading order — so a newly added
  // group surfaces without editing this file. The list is derived, not hardcoded:
  // nothing the spec describes can be silently dropped from the reference.
  const declaredTags: { name: string; description?: string }[] = spec.tags ?? []
  const tagOrder = declaredTags.map((t) => t.name)
  const TAG_DESC: Record<string, string> = Object.fromEntries(declaredTags.map((t) => [t.name, t.description ?? ""]))

  const ops: { path: string; method: string; op: RawOp; tag: string; anchor: string }[] = []
  for (const [path, item] of Object.entries(spec.paths as Record<string, Record<string, RawOp>>)) {
    for (const method of Object.keys(item)) {
      const op = item[method]
      ops.push({
        path,
        method,
        op,
        tag: op.tags?.[0] ?? "Other",
        anchor: op.operationId ?? `${method}-${path}`,
      })
    }
  }

  // Render the spec's declared order first, then append any tag that appears on
  // an operation but isn't declared (sorted, so it's stable) — an undeclared tag
  // is a generator gap, not a reason to hide its endpoints.
  const usedTags = [...new Set(ops.map((o) => o.tag))]
  const orderedTags = [
    ...tagOrder.filter((t) => usedTags.includes(t)),
    ...usedTags.filter((t) => !tagOrder.includes(t)).sort(),
  ]

  const groups: ReferenceGroup[] = orderedTags
    .map((tag) => ({
      tag,
      slug: tag.toLowerCase().replace(/\s+/g, "-"),
      desc: TAG_DESC[tag] || undefined,
      recipes: TAG_RECIPES[tag],
      ops: ops
        .filter((o) => o.tag === tag)
        .map((o) => ({
          path: o.path,
          method: o.method,
          op: o.op,
          anchor: o.anchor,
          run: o.op.operationId ? RUNS[o.op.operationId] : undefined,
          hint: TAG_HINT[tag] ?? "",
        })),
    }))
    .filter((g) => g.ops.length > 0)

  const sections: ReferenceSection[] = groups.flatMap((g) =>
    g.ops.map((o) => ({
      id: o.anchor,
      label: `${o.method.toUpperCase()} ${shortPath(o.path)}`,
      group: g.tag,
    }))
  )

  return { groups, sections }
}
