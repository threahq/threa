import { useMemo } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useAuth } from "@/auth"
import { useLabelService } from "@/contexts"
import { db, type CachedLabel, type CachedLabelMembership } from "@/db"
import { useWorkspaceLabels, useWorkspaceLabelMemberships, useWorkspaceUsers } from "@/stores/workspace-store"
import type { CreateLabelInput, Label, LabelMember, UpdateLabelInput } from "@threa/types"

export type { CachedLabel, CachedLabelMembership }

export const labelKeys = {
  all: ["labels"] as const,
  list: (workspaceId: string) => ["labels", workspaceId] as const,
}

function membershipId(workspaceId: string, labelId: string, userId: string): string {
  return `${workspaceId}:${labelId}:${userId}`
}

function labelToCached(label: Label): CachedLabel {
  return {
    id: label.id,
    workspaceId: label.workspaceId,
    visibility: label.visibility,
    creatorUserId: label.creatorUserId,
    name: label.name,
    slug: label.slug,
    color: label.color,
    emoji: label.emoji,
    description: label.description,
    createdAt: label.createdAt,
    updatedAt: label.updatedAt,
    archivedAt: label.archivedAt,
    _cachedAt: Date.now(),
  }
}

function memberToCached(member: LabelMember): CachedLabelMembership {
  return {
    id: membershipId(member.workspaceId, member.labelId, member.userId),
    workspaceId: member.workspaceId,
    labelId: member.labelId,
    userId: member.userId,
    joinedAt: member.joinedAt,
    _cachedAt: Date.now(),
  }
}

async function persistLabel(label: Label): Promise<void> {
  await db.labels.put(labelToCached(label))
}

async function removeLabel(workspaceId: string, labelId: string): Promise<void> {
  const memberIds = await db.labelMemberships.where("labelId").equals(labelId).primaryKeys()
  await db.transaction("rw", db.labels, db.labelMemberships, async () => {
    await db.labels.delete(labelId)
    if (memberIds.length > 0) {
      await db.labelMemberships.bulkDelete(memberIds as string[])
    }
  })
  void workspaceId
}

async function persistMembership(member: LabelMember): Promise<void> {
  await db.labelMemberships.put(memberToCached(member))
}

async function removeMembership(workspaceId: string, labelId: string, userId: string): Promise<void> {
  await db.labelMemberships.delete(membershipId(workspaceId, labelId, userId))
}

/**
 * Reconcile the workspace's cached labels + memberships with the authoritative
 * server response. Rows that exist in IDB for this workspace but are missing
 * from the response are deleted; rows in the response are upserted. Mirrors
 * the stream-sync / saved-sync reconciliation so labels that were archived
 * while we were offline don't linger in the catalog.
 */
export async function reconcileLabels(workspaceId: string, labels: Label[], memberships: LabelMember[]): Promise<void> {
  const labelIds = new Set(labels.map((l) => l.id))
  const memberKeys = new Set(memberships.map((m) => membershipId(m.workspaceId, m.labelId, m.userId)))

  const existingLabels = await db.labels.where("workspaceId").equals(workspaceId).primaryKeys()
  const existingMembers = await db.labelMemberships.where("workspaceId").equals(workspaceId).primaryKeys()

  const labelsToDelete = (existingLabels as string[]).filter((id) => !labelIds.has(id))
  const membersToDelete = (existingMembers as string[]).filter((key) => !memberKeys.has(key))

  await db.transaction("rw", db.labels, db.labelMemberships, async () => {
    if (labelsToDelete.length > 0) await db.labels.bulkDelete(labelsToDelete)
    if (membersToDelete.length > 0) await db.labelMemberships.bulkDelete(membersToDelete)
    if (labels.length > 0) await db.labels.bulkPut(labels.map(labelToCached))
    if (memberships.length > 0) await db.labelMemberships.bulkPut(memberships.map(memberToCached))
  })
}

/**
 * Refresh-on-mount server fetch. The render source is always IDB via the
 * workspace store; this background fetch keeps it warm and reconciles entries
 * that were created/archived while we were offline. Labels are part of the
 * workspace bootstrap, so first paint never blocks on this.
 */
export function useLabelsSync(workspaceId: string) {
  const labelService = useLabelService()

  useQuery({
    queryKey: labelKeys.list(workspaceId),
    queryFn: async () => {
      const res = await labelService.list(workspaceId)
      await reconcileLabels(workspaceId, res.labels, res.memberships)
      return res
    },
    staleTime: Infinity,
    refetchOnMount: true,
    refetchOnWindowFocus: false,
    refetchOnReconnect: true,
    enabled: !!workspaceId,
  })
}

export interface LabelViewerContext {
  /** Workspace-scoped user id (UserId) of the current viewer. */
  currentUserId: string | null
  /** Labels the viewer authored (private or public). */
  mine: CachedLabel[]
  /** Public labels in this workspace, sorted by name. Includes ones the viewer joined or created. */
  publicLabels: CachedLabel[]
  /** Public labels the viewer has not joined and did not create. */
  discoverable: CachedLabel[]
  /** Set of public labelIds the viewer has joined (excludes creator-implicit membership). */
  joinedLabelIds: Set<string>
  rawLabels: CachedLabel[]
  rawMemberships: CachedLabelMembership[]
}

/**
 * Bucket the workspace's labels into the views the Labels page needs. Private
 * labels are only visible to their creator (bootstrap already enforces this on
 * the wire). Public labels are visible to everyone in the workspace; "joined"
 * means the viewer has an explicit `LabelMember` row, "discoverable" is the
 * rest. Creators of a public label are joined implicitly (no membership row).
 */
export function useLabelsView(workspaceId: string): LabelViewerContext {
  const { user } = useAuth()
  const workspaceUsers = useWorkspaceUsers(workspaceId)
  const labels = useWorkspaceLabels(workspaceId)
  const memberships = useWorkspaceLabelMemberships(workspaceId)

  const currentUserId = useMemo(() => {
    if (!user) return null
    return workspaceUsers.find((u) => u.workosUserId === user.id)?.id ?? null
  }, [user, workspaceUsers])

  return useMemo(() => {
    const joinedLabelIds = new Set<string>()
    if (currentUserId) {
      for (const m of memberships) {
        if (m.userId === currentUserId) joinedLabelIds.add(m.labelId)
      }
    }

    const active = labels.filter((l) => !l.archivedAt)
    const byName = (a: CachedLabel, b: CachedLabel) => a.name.localeCompare(b.name)

    const mine = active.filter((l) => l.creatorUserId === currentUserId).sort(byName)
    const publicLabels = active.filter((l) => l.visibility === "public").sort(byName)
    const discoverable = publicLabels.filter((l) => l.creatorUserId !== currentUserId && !joinedLabelIds.has(l.id))

    return {
      currentUserId,
      mine,
      publicLabels,
      discoverable,
      joinedLabelIds,
      rawLabels: labels,
      rawMemberships: memberships,
    }
  }, [labels, memberships, currentUserId])
}

export function useCreateLabel(workspaceId: string) {
  const labelService = useLabelService()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (input: CreateLabelInput) => labelService.create(workspaceId, input),
    onSuccess: (label) => {
      void persistLabel(label)
      queryClient.invalidateQueries({ queryKey: labelKeys.list(workspaceId) })
    },
  })
}

export function useUpdateLabel(workspaceId: string) {
  const labelService = useLabelService()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: ({ labelId, input }: { labelId: string; input: UpdateLabelInput }) =>
      labelService.update(workspaceId, labelId, input),
    onSuccess: (label) => {
      void persistLabel(label)
      queryClient.invalidateQueries({ queryKey: labelKeys.list(workspaceId) })
    },
  })
}

export function useDeleteLabel(workspaceId: string) {
  const labelService = useLabelService()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (labelId: string) => labelService.delete(workspaceId, labelId),
    onSuccess: (_res, labelId) => {
      void removeLabel(workspaceId, labelId)
      queryClient.invalidateQueries({ queryKey: labelKeys.list(workspaceId) })
    },
  })
}

export function useJoinLabel(workspaceId: string) {
  const labelService = useLabelService()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (labelId: string) => labelService.join(workspaceId, labelId),
    onSuccess: (member) => {
      void persistMembership(member)
      queryClient.invalidateQueries({ queryKey: labelKeys.list(workspaceId) })
    },
  })
}

export function useLeaveLabel(workspaceId: string) {
  const labelService = useLabelService()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: ({ labelId, userId }: { labelId: string; userId: string }) =>
      labelService.leave(workspaceId, labelId).then(() => ({ labelId, userId })),
    onSuccess: ({ labelId, userId }) => {
      void removeMembership(workspaceId, labelId, userId)
      queryClient.invalidateQueries({ queryKey: labelKeys.list(workspaceId) })
    },
  })
}

export function usePromoteLabel(workspaceId: string) {
  const labelService = useLabelService()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (labelId: string) => labelService.promote(workspaceId, labelId),
    onSuccess: (label) => {
      void persistLabel(label)
      queryClient.invalidateQueries({ queryKey: labelKeys.list(workspaceId) })
    },
  })
}
