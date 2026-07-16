import {
  claimDelegation,
  finishDelegation,
  finishDelegationArgError,
  listDelegations,
  requestDelegationAccess,
  updateDelegation,
} from "../ops"
import { arrayFlag, enumFlag, kvPairs, stringFlag, UsageError, type CommandContext, type CommandSpec } from "../output"

const OUTCOMES = ["complete", "fail"] as const

async function runSubcommand(
  ctx: CommandContext,
  positionals: string[],
  values: Record<string, unknown>
): Promise<unknown> {
  const [sub, ...rest] = positionals
  const store = ctx.tokenStore
  const workspaceId = ctx.config.workspaceId

  if (sub === undefined) {
    return listDelegations(ctx.client, { since: stringFlag(values, "since") })
  }

  if (sub === "claim") {
    const id = rest[0]
    if (!id) throw new UsageError("delegations claim requires a <delegation-id>")
    const label = stringFlag(values, "label")
    if (!label) throw new UsageError('delegations claim requires --label "who is claiming"')
    return claimDelegation(ctx.client, store, workspaceId, {
      delegationId: id,
      claimedByLabel: label,
      idempotencyKey: stringFlag(values, "idempotency-key"),
    })
  }

  if (sub === "update") {
    const id = rest[0]
    if (!id) throw new UsageError("delegations update requires a <delegation-id>")
    return updateDelegation(ctx.client, store, workspaceId, {
      delegationId: id,
      statusNote: stringFlag(values, "note"),
      claimToken: stringFlag(values, "claim-token"),
    })
  }

  if (sub === "finish") {
    const id = rest[0]
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
    return finishDelegation(ctx.client, store, workspaceId, params)
  }

  if (sub === "request-access") {
    const id = rest[0]
    if (!id) throw new UsageError("delegations request-access requires a <delegation-id>")
    return requestDelegationAccess(ctx.client, id)
  }

  throw new UsageError(
    `unknown delegations subcommand "${sub}" — expected one of: claim, update, finish, request-access`
  )
}

export const delegationsCommand: CommandSpec = {
  name: "delegations",
  summary: "List and run the delegation lifecycle (claim / update / finish)",
  usage:
    "threa delegations [--since iso] | claim <id> --label who [--idempotency-key k] | " +
    "update <id> [--note ...] [--claim-token t] | " +
    "finish <id> --outcome complete|fail [--result md|-] [--error msg] [--metadata k=v]... [--claim-token t] | " +
    "request-access <id>",
  help:
    "threa delegations [subcommand] [flags]\n\n" +
    "Run a delegated task end to end. With no subcommand, list the open queue.\n\n" +
    "The claim token is persisted to ~/.threa/state.json (mode 0600, keyed by workspace and delegation), so " +
    "update and finish reuse it across separate `threa` invocations. Claim shows the token once; pass " +
    "--claim-token to override or recover it on another machine.\n\n" +
    "Subcommands:\n" +
    "  (none)                list open delegations; --since iso returns only tasks after that instant\n" +
    "  claim <id>            claim an open task; requires --label; --idempotency-key re-keys a crashed claim\n" +
    "  update <id>           renew the claim; --note posts progress, no note is a pure heartbeat\n" +
    "  finish <id>           close the task; --outcome complete|fail (fail requires --error)\n" +
    "  request-access <id>   bot-key only; file an access request for a stream the bot cannot see\n\n" +
    "Flags:\n" +
    "  --since iso           list filter: tasks created after this ISO-8601 instant\n" +
    "  --label who           claim: human-readable identity shown on the card\n" +
    "  --idempotency-key k   claim: persist before claiming to re-key a crashed claim (8-128 chars)\n" +
    "  --note text           update: progress note (renews the 15-min TTL)\n" +
    "  --outcome o           finish: complete | fail\n" +
    "  --result md           finish (complete): markdown posted into the stream; `-` reads stdin\n" +
    "  --error msg           finish (fail): why it failed\n" +
    "  --metadata k=v        finish (complete): stamp the result message; repeatable\n" +
    "  --claim-token t       update/finish: override the stored token\n" +
    "  --json                force JSON output\n" +
    "  --help                show this help",
  options: {
    since: { type: "string" },
    label: { type: "string" },
    "idempotency-key": { type: "string" },
    note: { type: "string" },
    outcome: { type: "string" },
    result: { type: "string" },
    error: { type: "string" },
    metadata: { type: "string", multiple: true },
    "claim-token": { type: "string" },
  },
  run: runSubcommand,
  render: (payload) => {
    if (Array.isArray((payload as { data?: unknown }).data)) {
      const rows = (payload as { data: Array<{ id?: string; title?: string; brief?: string }> }).data
      return (
        rows.map((d) => `${d.id ?? "?"}  ${d.title ?? d.brief ?? ""}`.trimEnd()).join("\n") || "(no open delegations)"
      )
    }
    const data = (payload as { data?: { id?: string; claimToken?: string; status?: string } }).data
    const lines: string[] = []
    if (data?.id) lines.push(`delegation: ${data.id}`)
    if (data?.status) lines.push(`status: ${data.status}`)
    if (data?.claimToken) lines.push(`claimToken (shown once): ${data.claimToken}`)
    return lines.join("\n") || JSON.stringify(payload)
  },
}
