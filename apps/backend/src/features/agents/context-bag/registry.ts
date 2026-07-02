import { ContextIntents, ContextRefKinds, type ContextIntent, type ContextRef } from "@threa/types"
import type { Querier } from "../../../db"
import { ThreadResolver } from "./resolvers/thread-resolver"
import { ConversationResolver } from "./resolvers/conversation-resolver"
import { DiscussThreadIntent } from "./intents/discuss-thread"
import type { IntentConfig, ResolvedRef, ResolverFetchOptions } from "./types"

const intents = new Map<ContextIntent, IntentConfig>()
intents.set(ContextIntents.DISCUSS_THREAD, DiscussThreadIntent)

export function getIntentConfig(intent: ContextIntent): IntentConfig {
  const config = intents.get(intent)
  if (!config) {
    throw new Error(`No intent config registered for intent "${intent}"`)
  }
  return config
}

// The three functions below are the ref-resolution registry. A `switch` on
// `ref.kind` (rather than a keyed resolver table) is what lets each branch
// narrow `ref` to the concrete shape its resolver expects — a
// `Resolver<ThreadContextRef> | Resolver<ConversationContextRef>` union can't be
// invoked with a bare `ContextRef`. Adding a kind is a compile error here until
// its case is added (the switch is exhaustive), which is the point.

/** Stable cache/label key for a ref (`thread:<id>` / `conversation:<id>`). */
export function canonicalRefKey(ref: ContextRef): string {
  switch (ref.kind) {
    case ContextRefKinds.THREAD:
      return ThreadResolver.canonicalKey(ref)
    case ContextRefKinds.CONVERSATION:
      return ConversationResolver.canonicalKey(ref)
  }
}

/** Re-verify the caller can read the ref's source; throws HttpError otherwise. */
export function assertRefAccess(db: Querier, ref: ContextRef, userId: string, workspaceId: string): Promise<void> {
  switch (ref.kind) {
    case ContextRefKinds.THREAD:
      return ThreadResolver.assertAccess(db, ref, userId, workspaceId)
    case ContextRefKinds.CONVERSATION:
      return ConversationResolver.assertAccess(db, ref, userId, workspaceId)
  }
}

/** Materialize the ref's current messages + inputs manifest. */
export function fetchRef(
  db: Querier,
  ref: ContextRef,
  options?: ResolverFetchOptions
): Promise<Omit<ResolvedRef, "ref">> {
  switch (ref.kind) {
    case ContextRefKinds.THREAD:
      return ThreadResolver.fetch(db, ref, options)
    case ContextRefKinds.CONVERSATION:
      return ConversationResolver.fetch(db, ref, options)
  }
}
