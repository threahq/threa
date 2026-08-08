import {
  claimDelegation,
  finishDelegation,
  finishDelegationArgError,
  getDelegation,
  listDelegations,
  releaseDelegation,
  requestDelegationAccess,
  updateDelegation,
} from "../ops"
import {
  arrayFlag,
  enumFlag,
  kvPairs,
  renderList,
  stringFlag,
  UsageError,
  type NounSpec,
  type VerbSpec,
} from "../output"

const OUTCOMES = ["complete", "fail"] as const

function renderLifecycle(payload: unknown): string {
  const data = (payload as { data?: { id?: string; claimToken?: string; status?: string } }).data
  const lines: string[] = []
  if (data?.id) lines.push(`delegation: ${data.id}`)
  if (data?.status) lines.push(`status: ${data.status}`)
  if (data?.claimToken) lines.push(`claimToken (shown once): ${data.claimToken}`)
  return lines.join("\n") || JSON.stringify(payload)
}

const listVerb: VerbSpec = {
  name: "list",
  summary: "List open delegations; --since iso returns availability changes after that instant",
  usage: "threa delegations list [--since iso]",
  help:
    "threa delegations list [flags]\n\n" +
    "List open delegations. Pass --since to poll for a cheap delta.\n\n" +
    "Flags:\n" +
    "  --since iso   tasks whose availability changed after this ISO-8601 instant\n" +
    "  --json        force JSON output\n" +
    "  --help        show this help",
  options: {
    since: { type: "string" },
  },
  run: (ctx, _positionals, values) => listDelegations(ctx.client, { since: stringFlag(values, "since") }),
  render: (payload) => {
    return renderList<{ id?: string; title?: string; brief?: string }>(
      payload,
      (d) => `${d.id ?? "?"}  ${d.title ?? d.brief ?? ""}`.trimEnd(),
      { empty: "(no open delegations)" }
    )
  },
}

const getVerb: VerbSpec = {
  name: "get",
  summary: "Inspect a delegation's brief and context before claiming it",
  usage: "threa delegations get <id>",
  help: "threa delegations get <id> [--json]\n\nInspect a delegation without claiming it.\n",
  options: {},
  run: (ctx, positionals) => {
    const id = positionals[0]
    if (!id) throw new UsageError("delegations get requires a <delegation-id>")
    return getDelegation(ctx.client, id)
  },
  render: (payload) => JSON.stringify(payload, null, 2),
}

const claimVerb: VerbSpec = {
  name: "claim",
  summary: "Claim an open task; requires --label; --idempotency-key re-keys a crashed claim",
  usage: "threa delegations claim <id> --label who [--idempotency-key k]",
  help:
    "threa delegations claim <id> --label who [flags]\n\n" +
    "Claim an open task. The claim token is persisted to ~/.threa/state.json (mode 0600, keyed by workspace and " +
    "delegation), so update and finish reuse it across separate `threa` invocations. Claim shows the token once.\n\n" +
    "Flags:\n" +
    "  --label who           human-readable identity shown on the card (required)\n" +
    "  --idempotency-key k   persist before claiming to re-key a crashed claim (8-128 chars)\n" +
    "  --json                force JSON output\n" +
    "  --help                show this help",
  options: {
    label: { type: "string" },
    "idempotency-key": { type: "string" },
  },
  run: (ctx, positionals, values) => {
    const id = positionals[0]
    if (!id) throw new UsageError("delegations claim requires a <delegation-id>")
    const label = stringFlag(values, "label")
    if (!label) throw new UsageError('delegations claim requires --label "who is claiming"')
    return claimDelegation(ctx.client, ctx.tokenStore, ctx.config.workspaceId, {
      delegationId: id,
      claimedByLabel: label,
      idempotencyKey: stringFlag(values, "idempotency-key"),
    })
  },
  render: renderLifecycle,
}

const releaseVerb: VerbSpec = {
  name: "release",
  summary: "Release a live claim back to the open queue",
  usage: "threa delegations release <id> [--claim-token t]",
  help:
    "threa delegations release <id> [flags]\n\nRelease a live claim. The stored token is cleared only after success.\n\n" +
    "Flags:\n  --claim-token t    override the stored token\n  --json             force JSON output\n  --help             show this help",
  options: { "claim-token": { type: "string" } },
  run: (ctx, positionals, values) => {
    const id = positionals[0]
    if (!id) throw new UsageError("delegations release requires a <delegation-id>")
    return releaseDelegation(ctx.client, ctx.tokenStore, ctx.config.workspaceId, {
      delegationId: id,
      claimToken: stringFlag(values, "claim-token"),
    })
  },
  render: renderLifecycle,
}

const updateVerb: VerbSpec = {
  name: "update",
  summary: "Renew the claim; --note posts progress, no note is a pure heartbeat",
  usage: "threa delegations update <id> [--note ...] [--claim-token t]",
  help:
    "threa delegations update <id> [flags]\n\n" +
    "Renew the claim (15-min TTL). Reuses the stored claim token; pass --claim-token to override or recover it.\n\n" +
    "Flags:\n" +
    "  --note text        progress note (renews the TTL); omit for a pure heartbeat\n" +
    "  --claim-token t    override the stored token\n" +
    "  --json             force JSON output\n" +
    "  --help             show this help",
  options: {
    note: { type: "string" },
    "claim-token": { type: "string" },
  },
  run: (ctx, positionals, values) => {
    const id = positionals[0]
    if (!id) throw new UsageError("delegations update requires a <delegation-id>")
    return updateDelegation(ctx.client, ctx.tokenStore, ctx.config.workspaceId, {
      delegationId: id,
      statusNote: stringFlag(values, "note"),
      claimToken: stringFlag(values, "claim-token"),
    })
  },
  render: renderLifecycle,
}

const finishVerb: VerbSpec = {
  name: "finish",
  summary: "Close the task; --outcome complete|fail (fail requires --error)",
  usage:
    "threa delegations finish <id> --outcome complete|fail [--result md|-] [--error msg] [--metadata k=v]... " +
    "[--claim-token t]",
  help:
    "threa delegations finish <id> --outcome complete|fail [flags]\n\n" +
    "Close a claimed task. Reuses the stored claim token; --claim-token overrides it. Finish clears the token.\n\n" +
    "Flags:\n" +
    "  --outcome o        complete | fail (required)\n" +
    "  --result md        outcome (complete): markdown posted into the stream; `-` reads stdin\n" +
    "  --error msg        outcome (fail): why it failed\n" +
    "  --metadata k=v     outcome (complete): stamp the result message; repeatable\n" +
    "  --claim-token t    override the stored token\n" +
    "  --json             force JSON output\n" +
    "  --help             show this help",
  options: {
    outcome: { type: "string" },
    result: { type: "string" },
    error: { type: "string" },
    metadata: { type: "string", multiple: true },
    "claim-token": { type: "string" },
  },
  run: async (ctx, positionals, values) => {
    const id = positionals[0]
    if (!id) throw new UsageError("delegations finish requires a <delegation-id>")
    const outcome = enumFlag(values, "outcome", OUTCOMES)
    if (!outcome) throw new UsageError("delegations finish requires --outcome complete|fail")
    const rawResult = stringFlag(values, "result")
    const resultMarkdown = rawResult === "-" ? await ctx.readStdin() : rawResult
    const metadataPairs = arrayFlag(values, "metadata")
    const params = {
      delegationId: id,
      outcome,
      resultMarkdown,
      metadata: metadataPairs ? kvPairs(metadataPairs) : undefined,
      errorMessage: stringFlag(values, "error"),
      claimToken: stringFlag(values, "claim-token"),
    }
    const argError = finishDelegationArgError(params)
    if (argError) throw new UsageError(argError)
    return finishDelegation(ctx.client, ctx.tokenStore, ctx.config.workspaceId, params)
  },
  render: renderLifecycle,
}

const requestAccessVerb: VerbSpec = {
  name: "request-access",
  summary: "Bot-key only; file an access request for a stream the bot cannot see",
  usage: "threa delegations request-access <id>",
  help:
    "threa delegations request-access <id> [flags]\n\n" +
    "Bot-key only. File an access request for a stream the bot cannot see, so an admin can grant it.\n\n" +
    "Flags:\n" +
    "  --json    force JSON output\n" +
    "  --help    show this help",
  options: {},
  run: (ctx, positionals) => {
    const id = positionals[0]
    if (!id) throw new UsageError("delegations request-access requires a <delegation-id>")
    return requestDelegationAccess(ctx.client, id)
  },
  render: renderLifecycle,
}

export const delegationsNoun: NounSpec = {
  name: "delegations",
  summary: "Run the delegation lifecycle end to end",
  verbs: [listVerb, getVerb, claimVerb, releaseVerb, updateVerb, finishVerb, requestAccessVerb],
}
