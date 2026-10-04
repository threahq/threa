import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { resolve } from "node:path"

const SRC = resolve(import.meta.dir, "../..")

type Treatment = "skips" | "serves" | "inert"

/**
 * The bridge writes a shared copy through the same events a local write
 * produces, so any handler that runs automation on those events would run it
 * a second time in the partner's workspace over content the host owns. Every
 * handler declares what it does with a copy's events; a new one fails here
 * until it does.
 */
const COPY_TREATMENT: Record<string, { treatment: Treatment; why: string }> = {
  "features/activity/outbox-handler.ts": {
    treatment: "serves",
    why: "local members of a copy are notified; ActivityRepository never writes rows for a user copy",
  },
  "features/agents/companion-outbox-handler.ts": { treatment: "skips", why: "no AI turns on host content" },
  "features/agents/context-bag-precompute-handler.ts": {
    treatment: "inert",
    why: "runs for new scratchpads, never a channel or thread",
  },
  "features/agents/mention-invoke-outbox-handler.ts": { treatment: "skips", why: "no AI turns on host content" },
  "features/agents/message-mutation-outbox-handler.ts": {
    treatment: "inert",
    why: "reruns agent sessions, which never start on a copy",
  },
  "features/analytics/outbox-handler.ts": {
    treatment: "skips",
    why: "a copy is created by the bridge, not its named creator; user copies hold no consent",
  },
  "features/attachments/embedding-outbox-handler.ts": { treatment: "inert", why: "copies carry no attachments" },
  "features/attachments/uploaded-outbox-handler.ts": { treatment: "inert", why: "copies carry no attachments" },
  "features/bot-runtimes/invocation-outbox-handler.ts": { treatment: "skips", why: "no bot turns on host content" },
  "features/commands/outbox-handler.ts": {
    treatment: "serves",
    why: "a local member's own command; writes into the copy are refused by its write authority",
  },
  "features/conversations/boundary-extraction-outbox-handler.ts": {
    treatment: "skips",
    why: "no AI extraction over host content",
  },
  "features/conversations/embedding-outbox-handler.ts": {
    treatment: "inert",
    why: "conversations come from boundary extraction, which skips copies",
  },
  "features/dynamic-naming/outbox-handler.ts": { treatment: "skips", why: "a copy takes its name from the host" },
  "features/emoji/usage-outbox-handler.ts": {
    treatment: "skips",
    why: "host members' emoji use is not a partner preference",
  },
  "features/enclave-runtimes/dispatch/enclave-dispatch-handler.ts": {
    treatment: "inert",
    why: "E2E streams only, which are never shared",
  },
  "features/invitations/shadow-sync-outbox-handler.ts": { treatment: "inert", why: "workspace invitations only" },
  "features/link-previews/outbox-handler.ts": { treatment: "skips", why: "no fetching on behalf of host content" },
  "features/memos/accumulator-outbox-handler.ts": { treatment: "skips", why: "no memory over host content" },
  "features/memos/embedding-outbox-handler.ts": { treatment: "skips", why: "no memory over host content" },
  "features/push/call-ring-outbox-handler.ts": {
    treatment: "inert",
    why: "a call cannot start on a copy; its write authority refuses",
  },
  "features/push/outbox-handler.ts": {
    treatment: "serves",
    why: "follows activity:created, which only local users receive",
  },
  "features/stream-connections/poke-outbox-handler.ts": {
    treatment: "serves",
    why: "pokes partners about host channels; a copy has no host connection here",
  },
  "features/system-messages/outbox-handler.ts": {
    treatment: "inert",
    why: "budget alerts and invitation acceptance only",
  },
  "features/workspace-integrations/route-sync-outbox-handler.ts": { treatment: "inert", why: "GitHub routes only" },
  "lib/outbox/broadcast-handler.ts": { treatment: "serves", why: "fans a copy's events out to local sockets" },
}

async function outboxHandlerFiles(): Promise<Map<string, string>> {
  const files = new Map<string, string>()
  for await (const path of new Bun.Glob("**/*.ts").scan({ cwd: SRC })) {
    if (path.endsWith(".test.ts")) continue
    const source = await readFile(resolve(SRC, path), "utf-8")
    if (/^export abstract class/m.test(source)) continue
    if (/\b(extends DebouncedOutboxHandler|implements OutboxHandler)\b/.test(source)) files.set(path, source)
  }
  return files
}

describe("outbox handler treatment of shared copies", () => {
  test("should declare a copy treatment when a file defines an outbox handler", async () => {
    const files = await outboxHandlerFiles()
    expect([...files.keys()].sort()).toEqual(Object.keys(COPY_TREATMENT).sort())
  })

  test("should name a copy predicate when a handler declares that it skips copies", async () => {
    const files = await outboxHandlerFiles()
    const unchecked = Object.entries(COPY_TREATMENT)
      .filter(
        ([path, { treatment }]) =>
          treatment === "skips" && !/isSharedCopy|findSharedCopyRefs|originWorkspaceId/.test(files.get(path) ?? "")
      )
      .map(([path]) => path)
    expect(unchecked).toEqual([])
  })
})
