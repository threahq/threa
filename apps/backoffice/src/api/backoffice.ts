import type { WorkspaceInvitableRole, WorkspaceRoleSlug } from "@threa/types"
import { api } from "./client"

/**
 * Typed fetchers + query keys for the `/api/backoffice/*` surface. Keeping all
 * of them in one place lets pages import a single module and lets query keys
 * stay colocated with the fetchers that produce them.
 */

export interface WorkspaceSummary {
  id: string
  name: string
  slug: string
  region: string
  createdByWorkosUserId: string
  workosOrganizationId: string | null
  memberCount: number
  createdAt: string
  updatedAt: string
}

export interface WorkspaceOwnerSummary {
  workosUserId: string
  email: string | null
  name: string | null
}

export interface WorkspaceDetail extends WorkspaceSummary {
  owner: WorkspaceOwnerSummary
}

export interface WorkspaceRef {
  id: string
  name: string
  slug: string
}

export interface WorkspaceOwnerInvitation {
  id: string
  email: string
  state: "pending" | "accepted" | "revoked" | "expired"
  acceptedAt: string | null
  revokedAt: string | null
  expiresAt: string
  createdAt: string
  updatedAt: string
  workspaces: WorkspaceRef[]
}

export interface BackofficeConfig {
  /** Base URL of the user-facing app, e.g. `https://app.threa.io`. Empty when unset. */
  workspaceAppBaseUrl: string
  /** WorkOS dashboard environment id, e.g. `environment_01KA3BVA…`. Null when unset. */
  workosEnvironmentId: string | null
}

export interface WorkspaceMember {
  workosUserId: string
  email: string | null
  firstName: string | null
  lastName: string | null
  status: string
  roleSlugs: string[]
  lastEventAt: string
}

export interface ResyncWorkspaceMembersResult {
  membershipsUpserted: number
  membershipsRemoved: number
  /**
   * Decimal-encoded outbox event ids emitted by the re-sync. Empty when the
   * mirror was already up to date. Poll {@link getOutboxEventsStatus} with
   * these to surface fan-out progress.
   */
  outboxEventIds: string[]
}

export type OutboxEventProcessingStatus = "processed" | "pending" | "dead_lettered"

export interface OutboxEventStatus {
  id: string
  status: OutboxEventProcessingStatus
}

export interface WorkspaceInvitation {
  id: string
  kind: "email" | "link"
  email: string | null
  roleSlug: WorkspaceInvitableRole
  expiresAt: string
  createdAt: string
  inviter: {
    workosUserId: string
    email: string | null
    name: string | null
  } | null
}

export interface WaitlistEntry {
  id: string
  email: string
  source: string | null
  status: string
  createdAt: string
}

export interface WaitlistStats {
  total: number
  pending: number
  invited: number
}

export interface WaitlistOverview {
  entries: WaitlistEntry[]
  stats: WaitlistStats
  /** True when there are more signups than `entries` contains (list is capped). */
  truncated: boolean
}

export interface WorkspaceFeatureFlagOverride {
  workosUserId: string
  flagKey: string
  enabled: boolean
  updatedAt: string
}

export interface WorkspaceFeatureFlags {
  /** Flag keys currently in the code registry (@threa/types FEATURE_FLAG_KEYS). */
  flagKeys: string[]
  /** Stored per-user overrides; absence of an override means the default (off). */
  overrides: WorkspaceFeatureFlagOverride[]
}

export const backofficeKeys = {
  workspaces: ["backoffice", "workspaces"] as const,
  workspace: (id: string) => ["backoffice", "workspaces", id] as const,
  workspaceMembers: (id: string) => ["backoffice", "workspaces", id, "members"] as const,
  workspaceInvitations: (id: string) => ["backoffice", "workspaces", id, "invitations"] as const,
  workspaceFeatureFlags: (id: string) => ["backoffice", "workspaces", id, "feature-flags"] as const,
  invitations: ["backoffice", "invitations"] as const,
  waitlist: ["backoffice", "waitlist"] as const,
  config: ["backoffice", "config"] as const,
}

export function listWorkspaces(): Promise<WorkspaceSummary[]> {
  return api.get<{ workspaces: WorkspaceSummary[] }>("/api/backoffice/workspaces").then((r) => r.workspaces)
}

export function getWorkspace(id: string): Promise<WorkspaceDetail> {
  return api
    .get<{ workspace: WorkspaceDetail }>(`/api/backoffice/workspaces/${encodeURIComponent(id)}`)
    .then((r) => r.workspace)
}

export function listWorkspaceOwnerInvitations(): Promise<WorkspaceOwnerInvitation[]> {
  return api
    .get<{ invitations: WorkspaceOwnerInvitation[] }>("/api/backoffice/workspace-owner-invitations")
    .then((r) => r.invitations)
}

export function createWorkspaceOwnerInvitation(email: string): Promise<WorkspaceOwnerInvitation> {
  return api
    .post<{ invitation: WorkspaceOwnerInvitation }>("/api/backoffice/workspace-owner-invitations", {
      email,
    })
    .then((r) => r.invitation)
}

export function resendWorkspaceOwnerInvitation(id: string): Promise<WorkspaceOwnerInvitation> {
  return api
    .post<{
      invitation: WorkspaceOwnerInvitation
    }>(`/api/backoffice/workspace-owner-invitations/${encodeURIComponent(id)}/resend`)
    .then((r) => r.invitation)
}

export function revokeWorkspaceOwnerInvitation(id: string): Promise<void> {
  return api.post<void>(`/api/backoffice/workspace-owner-invitations/${encodeURIComponent(id)}/revoke`)
}

export function getBackofficeConfig(): Promise<BackofficeConfig> {
  return api.get<{ config: BackofficeConfig }>("/api/backoffice/config").then((r) => r.config)
}

export function getWaitlist(): Promise<WaitlistOverview> {
  return api.get<{ waitlist: WaitlistOverview }>("/api/backoffice/waitlist").then((r) => r.waitlist)
}

export function listWorkspaceMembers(id: string): Promise<WorkspaceMember[]> {
  return api
    .get<{ members: WorkspaceMember[] }>(`/api/backoffice/workspaces/${encodeURIComponent(id)}/members`)
    .then((r) => r.members)
}

export function resyncWorkspaceMembers(id: string): Promise<ResyncWorkspaceMembersResult> {
  return api
    .post<{
      result: ResyncWorkspaceMembersResult
    }>(`/api/backoffice/workspaces/${encodeURIComponent(id)}/members/resync`)
    .then((r) => r.result)
}

const OUTBOX_STATUS_BATCH_SIZE = 200

export async function getOutboxEventsStatus(ids: string[]): Promise<OutboxEventStatus[]> {
  if (ids.length === 0) return []
  const batches: string[][] = []
  for (let i = 0; i < ids.length; i += OUTBOX_STATUS_BATCH_SIZE) {
    batches.push(ids.slice(i, i + OUTBOX_STATUS_BATCH_SIZE))
  }
  const responses = await Promise.all(
    batches.map((batch) => {
      const params = new URLSearchParams({ ids: batch.join(",") })
      return api.get<{ statuses: OutboxEventStatus[] }>(`/api/backoffice/outbox-events/status?${params.toString()}`)
    })
  )
  return responses.flatMap((r) => r.statuses)
}

export function listWorkspaceInvitations(id: string): Promise<WorkspaceInvitation[]> {
  return api
    .get<{ invitations: WorkspaceInvitation[] }>(`/api/backoffice/workspaces/${encodeURIComponent(id)}/invitations`)
    .then((r) => r.invitations)
}

export function getWorkspaceFeatureFlags(workspaceId: string): Promise<WorkspaceFeatureFlags> {
  return api.get<WorkspaceFeatureFlags>(`/api/backoffice/workspaces/${encodeURIComponent(workspaceId)}/feature-flags`)
}

/** `enabled: null` clears the override (back to the default: off). */
export function setWorkspaceFeatureFlag(
  workspaceId: string,
  params: { workosUserId: string; flagKey: string; enabled: boolean | null }
): Promise<void> {
  return api.put<void>(`/api/backoffice/workspaces/${encodeURIComponent(workspaceId)}/feature-flags`, params)
}

export function assignWorkspaceMember(
  workspaceId: string,
  workosUserId: string,
  roleSlug: WorkspaceRoleSlug
): Promise<void> {
  return api.post<void>(`/api/backoffice/workspaces/${encodeURIComponent(workspaceId)}/members`, {
    workosUserId,
    roleSlug,
  })
}

export function changeWorkspaceMemberRole(
  workspaceId: string,
  workosUserId: string,
  roleSlug: WorkspaceRoleSlug
): Promise<void> {
  return api.post<void>(
    `/api/backoffice/workspaces/${encodeURIComponent(workspaceId)}/members/${encodeURIComponent(workosUserId)}/role`,
    { roleSlug }
  )
}

export function removeWorkspaceMember(workspaceId: string, workosUserId: string): Promise<void> {
  return api.delete<void>(
    `/api/backoffice/workspaces/${encodeURIComponent(workspaceId)}/members/${encodeURIComponent(workosUserId)}`
  )
}
