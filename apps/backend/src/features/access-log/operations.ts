/**
 * Single source of truth for access-log enumerations (INV-33), typed via
 * `as const` derivation (INV-31). Operation names are dot-namespaced
 * `feature.action` per design §8; the HTTP/socket/AI capture layers only accept
 * an `AccessLogOperation`, so every logged operation must be listed here.
 */

import type { OperationId } from "../public-api"

export const ACCESS_KINDS = ["read", "write", "subscribe", "unsubscribe", "disclose"] as const
export type AccessKind = (typeof ACCESS_KINDS)[number]

export const ACCESS_OUTCOMES = ["success", "denied", "error"] as const
export type AccessOutcome = (typeof ACCESS_OUTCOMES)[number]

/**
 * Actor types for the audit log. Overlaps but is NOT `AUTHOR_TYPES` in
 * `@threa/types` — `api_key` is not an author, and audit collapses external
 * key holders onto their underlying `user`/`bot`. Kept local on purpose.
 */
export const ACTOR_TYPES = ["user", "persona", "bot", "system"] as const
export type ActorType = (typeof ACTOR_TYPES)[number]

/**
 * Every operation the annotated `/api` routes, sockets, and AI egress can name.
 * The boot-time coverage guard (`assertAuditCoverage`) enforces that every
 * annotated route names one of these; the `audit(...)` factory only accepts an
 * `AccessLogOperation`, so an unlisted name fails the typecheck.
 */
export const ACCESS_LOG_OPERATIONS = [
  // Auth / workspace surface
  "auth.me",
  "auth.boundary_denied",
  "workspace.list",
  "workspace.create",
  "workspace.get",
  "workspace.bootstrap",
  "workspace.list_users",
  "workspace.slug_available",
  "workspace.complete_setup",
  "workspace.update_profile",
  "workspace.set_status",
  "workspace.clear_status",
  "workspace.pause_notifications",
  "workspace.resume_notifications",
  "workspace.upload_avatar",
  "workspace.remove_avatar",
  "emoji.list",
  "preferences.get",
  "preferences.update",
  "workspace_settings.get",
  "workspace_settings.update",
  // Personas
  "personas.list",
  "personas.list_archived",
  "personas.create",
  "personas.get_config",
  "personas.put_override",
  "personas.update",
  "personas.archive",
  "personas.unarchive",
  "personas.list_revisions",
  "personas.restore_revision",
  "personas.put_draft",
  "personas.delete_draft",
  "personas.create_test_stream",
  "personas.upload_avatar",
  "personas.remove_avatar",
  "personas.bind_attachment",
  "personas.attach_from_existing",
  "personas.delete_attachment",
  // Sidebar / E2E keys / enclave
  "sidebar_config.get",
  "sidebar_config.update",
  "user_e2e_keys.get",
  "user_e2e_keys.set",
  "user_e2e_keys.revoke",
  "enclave.list_active_keys",
  // Streams
  "stream_context.list",
  "stream_context.occurrences",
  "streams.list",
  "streams.create",
  "streams.read_all",
  "streams.slug_available",
  "streams.get",
  "streams.update",
  "streams.regenerate_title",
  "streams.bootstrap",
  "streams.get_brief",
  "streams.put_brief",
  "streams.update_companion",
  "streams.update_tool_policy",
  "streams.set_notification_level",
  "streams.join",
  "streams.invite_actor",
  "streams.get_e2e_key_wraps",
  "streams.store_e2e_key_wrap",
  "streams.revive_e2e_actor_key_wraps",
  "streams.roll_e2e_key",
  "streams.mark_read",
  "streams.mark_unread",
  "streams.archive",
  "streams.unarchive",
  "streams.add_member",
  "streams.remove_member",
  "streams.history",
  "streams.around",
  "streams.catchup",
  // Search
  "search.messages",
  "search.memos",
  // Memos
  "memos.read",
  "memos.update",
  "memos.archive",
  "memos.unarchive",
  "memos.delete",
  // Messages
  "messages.create",
  "messages.validate_move_to_thread",
  "messages.move_to_thread",
  "messages.update",
  "messages.delete",
  "messages.get_history",
  "messages.add_reaction",
  "messages.remove_reaction",
  // Attachments
  "attachments.upload",
  "attachments.reserve",
  "attachments.complete_content",
  "attachments.report_upload_failure",
  "attachments.search",
  "attachments.presign",
  "attachments.content",
  "attachments.extraction",
  "attachments.delete",
  // Conversations / board
  "conversations.list",
  "conversations.list_by_stream",
  "conversations.get",
  "conversations.get_messages",
  "conversations.get_board_messages",
  "conversations.get_board_post",
  "conversations.update",
  "conversations.regenerate_title",
  "conversations.hide",
  "conversations.unhide",
  "conversations.mute_stream",
  "conversations.unmute_stream",
  "conversations.reassign_message",
  "conversations.settle_message",
  "conversations.split_thread",
  "conversations.reassign_messages",
  "conversations.propose_split",
  "conversations.apply_split",
  "conversations.mark_read",
  "conversations.mark_unread",
  "board.get_exclusions",
  "board.list_views",
  "board.create_view",
  "board.update_view",
  "board.delete_view",
  // Commands
  "commands.dispatch",
  "commands.list",
  // Members / invitations
  "members.change_role",
  "members.remove",
  "invitations.list",
  "invitations.send",
  "invitations.create_link",
  "invitations.revoke",
  "invitations.resend",
  // AI usage
  "ai_usage.get",
  "ai_usage.get_recent",
  "ai_usage.get_budget",
  "ai_usage.update_budget",
  // Activity
  "activity.list",
  "activity.mark_all_read",
  "activity.mark_one_read",
  // Saved
  "saved_messages.list",
  "saved_messages.create",
  "saved_messages.update",
  "saved_messages.delete",
  "saved_suggestions.list",
  "saved_suggestions.accept",
  "saved_suggestions.dismiss",
  // Labels
  "labels.list",
  "labels.list_messages",
  "labels.create",
  "labels.update",
  "labels.delete",
  "labels.assign",
  "labels.unassign",
  // Scheduled messages
  "scheduled_messages.list",
  "scheduled_messages.create",
  "scheduled_messages.get",
  "scheduled_messages.update",
  "scheduled_messages.delete",
  "scheduled_messages.lock",
  "scheduled_messages.unlock",
  "scheduled_messages.send_now",
  // Agent follow-ups / delegations / bot-access
  "agent_follow_ups.cancel",
  "agent_outcomes.list",
  "delegations.list",
  "delegations.get",
  "delegations.cancel",
  "delegations.mark_done",
  "bot_access_requests.approve",
  "bot_access_requests.deny",
  // Drafts
  "drafts.list",
  "drafts.upsert",
  "drafts.resolve",
  "drafts.delete",
  // Performance diagnostics
  "perf_capture.create",
  // Push
  "push.get_vapid_key",
  "push.subscribe",
  "push.unsubscribe",
  "push.test",
  "push.cleanup_endpoint",
  // Agent sessions / context bag
  "agent_sessions.get",
  "context_bag.precompute",
  "context_bag.get_stream_bag",
  // Link previews
  "link_previews.get_for_message",
  "link_previews.dismiss",
  "link_previews.resolve_in_app",
  "link_previews.resolve_in_app_by_id",
  // Giphy
  "giphy.get_config",
  "giphy.search",
  "giphy.trending",
  // Workspace integrations
  "integrations.get_github",
  "integrations.connect_github",
  "integrations.disconnect_github",
  "integrations.sync_github",
  "integrations.get_linear",
  "integrations.connect_linear",
  "integrations.disconnect_linear",
  "integrations.github_callback",
  "integrations.linear_callback",
  // User API keys
  "user_api_keys.list",
  "user_api_keys.create",
  "user_api_keys.update",
  "user_api_keys.revoke",
  // Voice
  "voice.create_session",
  "voice.abort_session",
  // Calls (voice/video)
  "calls.start",
  "calls.bootstrap",
  "calls.leave",
  "calls.decline_invitation",
  "calls.cancel_invitation",
  "calls.cf_session",
  "calls.cf_renegotiate",
  "calls.cf_publish_tracks",
  "calls.cf_pull_tracks",
  "calls.cf_close_tracks",
  // Bots
  "bot.hello_bootstrap",
  "bot.presence_update",
  "bot.invocation_renew",
  "bot.invocation_steps",
  "bot.invocation_sealed_steps",
  "bots.list",
  "bots.create",
  "bots.get",
  "bots.update",
  "bots.archive",
  "bots.restore",
  "bots.list_keys",
  "bots.create_key",
  "bots.update_key",
  "bots.revoke_key",
  "bots.upload_avatar",
  "bots.remove_avatar",
  "bots.list_stream_grants",
  "bots.grant_stream_access",
  "bots.revoke_stream_access",
  "bots.list_stream_bots",
  // Sockets (step 3)
  "socket.subscribe",
  "socket.unsubscribe",
] as const

/**
 * Public-API operations are named `public_api.<operationId>` from the registry's
 * `operationId` (the SSOT). Enumerating all ~60 by hand would duplicate that
 * registry, so the type is a template literal over `OperationId` and the
 * constructor validates nothing at runtime (the registry loop is the only
 * caller and passes a real `OperationId`).
 */
export type PublicApiOperation = `public_api.${OperationId}`

export function publicApiOperation(operationId: OperationId): PublicApiOperation {
  return `public_api.${operationId}`
}

/**
 * AI egress operations are named `ai.<functionId>` from the wrapper's telemetry
 * `functionId` (e.g. `ai.agent-loop`, `ai.memorize-conversation`,
 * `ai.message-embedding`). functionIds are defined at hundreds of call sites and
 * are not a closed set, so — like `public_api.*` — the type is a template
 * literal and the constructor validates nothing at runtime.
 */
export type AiOperation = `ai.${string}`

export function aiOperation(functionId: string): AiOperation {
  return `ai.${functionId}`
}

export type AccessLogOperation = (typeof ACCESS_LOG_OPERATIONS)[number] | PublicApiOperation | AiOperation
