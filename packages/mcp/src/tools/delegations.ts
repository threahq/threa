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
        "report_delegation_status / delegation_heartbeat while you work → complete_delegation or fail_delegation. " +
        "The result of complete_delegation is posted into the delegation's stream and GAM memorizes it. `status` " +
        "is `open` (the only listable state today). `since` is an ISO-8601 datetime that returns only tasks " +
        "created after that instant — a cheap delta for a polling runner.",
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
        "this session. The claim has a 15-minute TTL: call delegation_heartbeat (or report_delegation_status) to " +
        "renew it before it lapses, or the task returns to the queue. `claimed_by_label` is your human-readable " +
        'identity shown on the card (e.g. "Kris\'s MacBook / Claude Code"). `idempotency_key` re-keys your own ' +
        "live claim after a crash: persist it BEFORE claiming, and a retry bearing the same key hands back a " +
        "fresh token and lease instead of a 409. A 409 DELEGATION_NOT_OPEN means you lost the race — another " +
        "runner already claimed it.",
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
    "delegation_heartbeat",
    {
      title: "Renew a delegation claim",
      description:
        "Push the claim's 15-minute TTL forward while you are still working. Liveness only — no status note, no " +
        "card change. Uses the claim token from claim_delegation (stored in memory this session); pass " +
        "`claim_token` to override the stored one or recover after a server restart. A 404 means the claim " +
        "lapsed or was lost — re-claim the delegation.",
      inputSchema: {
        delegation_id: z.string(),
        claim_token: z.string().optional(),
      },
    },
    async ({ delegation_id, claim_token }) =>
      withToken(delegation_id, claim_token, (headers) =>
        client.post(`/delegations/${encodeURIComponent(delegation_id)}/heartbeat`, undefined, headers)
      )
  )

  server.registerTool(
    "report_delegation_status",
    {
      title: "Report delegation progress",
      description:
        "Mark the delegation running and optionally put a free-text progress note on its card; each report " +
        "replaces the previous note and renews the claim TTL. Omit `status_note` to just mark it running. Uses " +
        "the stored claim token (pass `claim_token` to override or recover). A 404 means the claim lapsed — " +
        "re-claim the delegation.",
      inputSchema: {
        delegation_id: z.string(),
        status_note: z.string().min(1).max(2000).optional(),
        claim_token: z.string().optional(),
      },
    },
    async ({ delegation_id, status_note, claim_token }) =>
      withToken(delegation_id, claim_token, (headers) =>
        client.post(
          `/delegations/${encodeURIComponent(delegation_id)}/status`,
          status_note ? { statusNote: status_note } : {},
          headers
        )
      )
  )

  server.registerTool(
    "complete_delegation",
    {
      title: "Complete a delegation",
      description:
        "Terminal success. Provide `result_markdown` to post the outcome into the delegation's stream (authored " +
        "as this key's identity, entering the normal message pipeline so GAM memorizes it); omit it to close " +
        "without a message. `metadata` is a flat string→string map stamped on the result message for later " +
        "lookup via find_messages_by_metadata. Uses the stored claim token (pass `claim_token` to override or " +
        "recover). On success the stored token is cleared — the claim is spent.",
      inputSchema: {
        delegation_id: z.string(),
        result_markdown: z.string().min(1).max(50000).optional(),
        metadata: z.record(z.string(), z.string()).optional(),
        claim_token: z.string().optional(),
      },
    },
    async ({ delegation_id, result_markdown, metadata, claim_token }) => {
      const body: Record<string, unknown> = {}
      if (result_markdown) body.resultMarkdown = result_markdown
      if (metadata) body.metadata = metadata
      return withToken(delegation_id, claim_token, async (headers) => {
        const response = await client.post(`/delegations/${encodeURIComponent(delegation_id)}/complete`, body, headers)
        claimTokens.delete(delegation_id)
        return response
      })
    }
  )

  server.registerTool(
    "fail_delegation",
    {
      title: "Fail a delegation",
      description:
        "Terminal failure. Records `error_message` on the delegation's card so the delegator knows why the work " +
        "did not complete. Uses the stored claim token (pass `claim_token` to override or recover). On success " +
        "the stored token is cleared — the claim is spent.",
      inputSchema: {
        delegation_id: z.string(),
        error_message: z.string().min(1).max(2000),
        claim_token: z.string().optional(),
      },
    },
    async ({ delegation_id, error_message, claim_token }) =>
      withToken(delegation_id, claim_token, async (headers) => {
        const response = await client.post(
          `/delegations/${encodeURIComponent(delegation_id)}/fail`,
          { errorMessage: error_message },
          headers
        )
        claimTokens.delete(delegation_id)
        return response
      })
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
