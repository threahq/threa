import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import type { ThreaApiClient } from "../api-client"
import { CALLBACK_TOKEN_HEADER } from "./constants"
import { buildQuery, runTool, toolError } from "./result"

export function registerDelegationTools(server: McpServer, client: ThreaApiClient): void {
  const claimTokens = new Map<string, string>()

  function resolveToken(delegationId: string, explicit: string | undefined): string | undefined {
    return explicit ?? claimTokens.get(delegationId)
  }

  const missingTokenError = () =>
    toolError(
      "MISSING_CLAIM_TOKEN",
      "No claim token for this delegation. Pass claim_token — the value claim_delegation returned once. " +
        "The in-memory store has no token for this id (you did not claim it in this session, or the server " +
        "restarted since you claimed and lost the map)."
    )

  function withToken(
    delegationId: string,
    explicit: string | undefined,
    fn: (headers: Record<string, string>) => Promise<unknown>
  ) {
    const token = resolveToken(delegationId, explicit)
    if (!token) return Promise.resolve(missingTokenError())
    return runTool(() => fn({ [CALLBACK_TOKEN_HEADER]: token }))
  }

  server.registerTool(
    "list_delegations",
    {
      title: "List open delegations",
      description:
        "List the delegated tasks that are open to claim (the queue a `delegate_task` hand-off lands in). Only " +
        "streams this key can access appear. The lifecycle loop is: list_delegations → claim_delegation → " +
        "update_delegation while you work → finish_delegation (outcome complete or fail). A completed result is " +
        "posted into the delegation's stream and GAM memorizes it. `status` is `open` (the only listable state " +
        "today). `since` is an ISO-8601 datetime that returns only tasks created after that instant — a cheap " +
        "delta for a polling runner.",
      inputSchema: {
        status: z.literal("open").optional(),
        since: z.string().optional(),
      },
    },
    async ({ status, since }) => runTool(() => client.get(`/delegations${buildQuery({ status, since })}`))
  )

  server.registerTool(
    "claim_delegation",
    {
      title: "Claim an open delegation",
      description:
        "Atomically claim an open delegation so you can work it. On success the result carries the brief, the " +
        "context refs, and `claimToken` — SHOWN ONCE. Every later lifecycle call for this delegation needs that " +
        "token; this server also stashes it in memory so you can omit `claim_token` on the follow-up calls in " +
        "this session. The claim has a 15-minute TTL: call update_delegation to renew it before it lapses, or " +
        "the task returns to the queue. `claimed_by_label` is your human-readable " +
        'identity shown on the card (e.g. "Kris\'s MacBook / Claude Code"). `idempotency_key` re-keys your own ' +
        "live claim after a crash: persist it BEFORE claiming, and a retry bearing the same key hands back a " +
        "fresh token and lease instead of a 409. A 409 DELEGATION_NOT_OPEN means you lost the race — another " +
        "runner already claimed it. After claiming, keep the lease alive with update_delegation and close out " +
        "with finish_delegation.",
      inputSchema: {
        delegation_id: z.string(),
        claimed_by_label: z.string().min(1).max(200),
        idempotency_key: z.string().min(8).max(128).optional(),
      },
    },
    async ({ delegation_id, claimed_by_label, idempotency_key }) =>
      runTool(async () => {
        const response = await client.post<{ data: { claimToken?: string } }>(
          `/delegations/${encodeURIComponent(delegation_id)}/claim`,
          { claimedByLabel: claimed_by_label, idempotencyKey: idempotency_key }
        )
        const token = response.data?.claimToken
        if (token) claimTokens.set(delegation_id, token)
        return response
      })
  )

  server.registerTool(
    "update_delegation",
    {
      title: "Update a delegation's progress",
      description:
        "Keep a claimed delegation alive and, optionally, report progress. Pass `status_note` to mark the " +
        "delegation running and put a free-text note on its card (each note replaces the previous one) — this " +
        "also renews the claim's 15-minute TTL. Omit `status_note` for a pure heartbeat: liveness only, no card " +
        "change, TTL renewed. Uses the claim token from claim_delegation (stored in memory this session); pass " +
        "`claim_token` to override the stored one or recover after a server restart. A 404 means the claim " +
        "lapsed or was lost — re-claim the delegation.",
      inputSchema: {
        delegation_id: z.string(),
        status_note: z.string().min(1).max(2000).optional(),
        claim_token: z.string().optional(),
      },
    },
    async ({ delegation_id, status_note, claim_token }) =>
      withToken(delegation_id, claim_token, (headers) =>
        status_note
          ? client.post(
              `/delegations/${encodeURIComponent(delegation_id)}/status`,
              { statusNote: status_note },
              headers
            )
          : client.post(`/delegations/${encodeURIComponent(delegation_id)}/heartbeat`, undefined, headers)
      )
  )

  server.registerTool(
    "finish_delegation",
    {
      title: "Finish a delegation",
      description:
        'Terminally close a claimed delegation. `outcome: "complete"` marks success: provide `result_markdown` ' +
        "to post the outcome into the delegation's stream (authored as this key's identity, entering the normal " +
        "message pipeline so GAM memorizes it) or omit it to close without a message, and `metadata` (a flat " +
        "string→string map) stamps the result message for later find_messages_by_metadata lookup. " +
        '`outcome: "fail"` marks failure and REQUIRES `error_message` (recorded on the card so the delegator ' +
        "knows why); it rejects result_markdown/metadata. `error_message` is only valid with outcome=fail. Uses " +
        "the stored claim token (pass `claim_token` to override or recover). On success the stored token is " +
        "cleared — the claim is spent.",
      inputSchema: {
        delegation_id: z.string(),
        outcome: z.enum(["complete", "fail"]),
        result_markdown: z.string().min(1).max(50000).optional(),
        metadata: z.record(z.string(), z.string()).optional(),
        error_message: z.string().min(1).max(2000).optional(),
        claim_token: z.string().optional(),
      },
    },
    async ({ delegation_id, outcome, result_markdown, metadata, error_message, claim_token }) => {
      if (outcome === "fail") {
        if (!error_message) {
          return toolError("INVALID_ARGUMENT", "outcome=fail requires error_message.")
        }
        const misplaced: string[] = []
        if (result_markdown !== undefined) misplaced.push("result_markdown")
        if (metadata !== undefined) misplaced.push("metadata")
        if (misplaced.length > 0) {
          return toolError(
            "INVALID_ARGUMENT",
            `outcome=fail does not accept ${misplaced.join(", ")} — those belong to outcome=complete.`
          )
        }
      } else if (error_message !== undefined) {
        return toolError(
          "INVALID_ARGUMENT",
          "outcome=complete does not accept error_message — that belongs to outcome=fail."
        )
      }

      const path =
        outcome === "fail"
          ? `/delegations/${encodeURIComponent(delegation_id)}/fail`
          : `/delegations/${encodeURIComponent(delegation_id)}/complete`
      const body: Record<string, unknown> = {}
      if (outcome === "fail") {
        body.errorMessage = error_message
      } else {
        if (result_markdown) body.resultMarkdown = result_markdown
        if (metadata) body.metadata = metadata
      }

      return withToken(delegation_id, claim_token, async (headers) => {
        const response = await client.post(path, body, headers)
        claimTokens.delete(delegation_id)
        return response
      })
    }
  )

  server.registerTool(
    "request_delegation_access",
    {
      title: "Request access to a delegation's stream",
      description:
        "Bot-key only. When a workspace (bot) key sees a delegation it cannot claim because the bot lacks a " +
        "grant on the stream, file an access request that renders as a card for a member to approve. Returns " +
        "already_granted (no card) when the bot already has access. A user-scoped key gets 400 " +
        "USER_KEY_CANNOT_REQUEST_ACCESS — a user key's access follows its user, who should join the stream " +
        "directly.",
      inputSchema: {
        delegation_id: z.string(),
      },
    },
    async ({ delegation_id }) =>
      runTool(() => client.post(`/delegations/${encodeURIComponent(delegation_id)}/request-access`, {}))
  )
}
