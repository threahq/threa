import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import type { ThreaApiClient } from "../api-client"
import { claimDelegation, finishDelegation, listDelegations, requestDelegationAccess, updateDelegation } from "../ops"
import type { TokenStore } from "../token-store"
import { runTool } from "./result"

export function registerDelegationTools(
  server: McpServer,
  client: ThreaApiClient,
  store: TokenStore,
  workspaceId: string
): void {
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
    async ({ status, since }) => runTool(() => listDelegations(client, { status, since }))
  )

  server.registerTool(
    "claim_delegation",
    {
      title: "Claim an open delegation",
      description:
        "Atomically claim an open delegation so you can work it. On success the result carries the brief, the " +
        "context refs, and `claimToken` — SHOWN ONCE. Every later lifecycle call for this delegation needs that " +
        "token; this server also stashes it in a persistent state file (`~/.threa/state.json`) so you can omit " +
        "`claim_token` on the follow-up calls, and it survives a server restart. The claim has a 15-minute TTL: " +
        "call update_delegation to renew it before it lapses, or the task returns to the queue. `claimed_by_label` " +
        'is your human-readable identity shown on the card (e.g. "Kris\'s MacBook / Claude Code"). ' +
        "`idempotency_key` re-keys your own live claim after a crash: persist it BEFORE claiming, and a retry " +
        "bearing the same key hands back a fresh token and lease instead of a 409. A 409 DELEGATION_NOT_OPEN means " +
        "you lost the race — another runner already claimed it. After claiming, keep the lease alive with " +
        "update_delegation and close out with finish_delegation.",
      inputSchema: {
        delegation_id: z.string(),
        claimed_by_label: z.string().min(1).max(200),
        idempotency_key: z.string().min(8).max(128).optional(),
      },
    },
    async ({ delegation_id, claimed_by_label, idempotency_key }) =>
      runTool(() =>
        claimDelegation(client, store, workspaceId, {
          delegationId: delegation_id,
          claimedByLabel: claimed_by_label,
          idempotencyKey: idempotency_key,
        })
      )
  )

  server.registerTool(
    "update_delegation",
    {
      title: "Update a delegation's progress",
      description:
        "Keep a claimed delegation alive and, optionally, report progress. Pass `status_note` to mark the " +
        "delegation running and put a free-text note on its card (each note replaces the previous one) — this " +
        "also renews the claim's 15-minute TTL. Omit `status_note` for a pure heartbeat: liveness only, no card " +
        "change, TTL renewed. Uses the claim token from claim_delegation (persisted to `~/.threa/state.json`); " +
        "pass `claim_token` to override the stored one. A 404 means the claim lapsed or was lost — re-claim the " +
        "delegation.",
      inputSchema: {
        delegation_id: z.string(),
        status_note: z.string().min(1).max(2000).optional(),
        claim_token: z.string().optional(),
      },
    },
    async ({ delegation_id, status_note, claim_token }) =>
      runTool(() =>
        updateDelegation(client, store, workspaceId, {
          delegationId: delegation_id,
          statusNote: status_note,
          claimToken: claim_token,
        })
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
        "the stored claim token (pass `claim_token` to override). On success the stored token is cleared — the " +
        "claim is spent.",
      inputSchema: {
        delegation_id: z.string(),
        outcome: z.enum(["complete", "fail"]),
        result_markdown: z.string().min(1).max(50000).optional(),
        metadata: z.record(z.string(), z.string()).optional(),
        error_message: z.string().min(1).max(2000).optional(),
        claim_token: z.string().optional(),
      },
    },
    async ({ delegation_id, outcome, result_markdown, metadata, error_message, claim_token }) =>
      runTool(() =>
        finishDelegation(client, store, workspaceId, {
          delegationId: delegation_id,
          outcome,
          resultMarkdown: result_markdown,
          metadata,
          errorMessage: error_message,
          claimToken: claim_token,
        })
      )
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
    async ({ delegation_id }) => runTool(() => requestDelegationAccess(client, delegation_id))
  )
}
