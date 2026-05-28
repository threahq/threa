import { useMemo } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useAuth } from "@/auth"
import { useLabelService } from "@/contexts"
import { db, type CachedLabel, type CachedLabelMembership, type CachedLabelAssignment } from "@/db"
import {
  useWorkspaceLabels,
  useWorkspaceLabelMemberships,
  useWorkspaceLabelAssignments,
  useWorkspaceUsers,
} from "@/stores/workspace-store"
import { Visibilities } from "@threa/types"
import type {
  CreateLabelInput,
  Label,
  LabelAssignment,
  LabelableResourceType,
  LabelMember,
  UpdateLabelInput,
} from "@threa/types"

export type { CachedLabel, CachedLabelMembership, CachedLabelAssignment }

export const labelKeys = {
  all: ["labels"] as const,
  list: (workspaceId: string) => ["labels", workspaceId] as const,
}

function membershipId(workspaceId: string, labelId: string, userId: string): string {
  return `${workspaceId}:${labelId}:${userId}`
}

/**
 * Composite key for a cached assignment row. Resource-generic: the same shape
 * keys a stream, message, or any future labelable resource. Exported so the
 * socket-sync layer builds identical ids (no drift between optimistic writes
 * and `label:assigned` events).
 */
export function assignmentId(
  workspaceId: string,
  resourceType: LabelableResourceType,
  resourceId: string,
  labelId: string,
  userId: string
): string {
  return `${workspaceId}:${resourceType}:${resourceId}:${labelId}:${userId}`
}

export function assignmentToCached(assignment: LabelAssignment): CachedLabelAssignment {
  return {
    id: assignmentId(
      assignment.workspaceId,
      assignment.resourceType,
      assignment.resourceId,
      assignment.labelId,
      assignment.userId
    ),
    workspaceId: assignment.workspaceId,
    labelId: assignment.labelId,
    resourceType: assignment.resourceType,
    resourceId: assignment.resourceId,
    userId: assignment.userId,
    assignedAt: assignment.assignedAt,
    _cachedAt: Date.now(),
  }
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
  await db.transaction("rw", db.labels, db.labelMemberships, async () => {
    await db.labels.delete(labelId)
    const memberIds = await db.labelMemberships.where("labelId").equals(labelId).primaryKeys()
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

async function persistAssignment(assignment: LabelAssignment): Promise<void> {
  await db.labelAssignments.put(assignmentToCached(assignment))
}

async function removeAssignment(
  workspaceId: string,
  resourceType: LabelableResourceType,
  resourceId: string,
  labelId: string,
  userId: string
): Promise<void> {
  await db.labelAssignments.delete(assignmentId(workspaceId, resourceType, resourceId, labelId, userId))
}

/**
 * Reconcile the workspace's cached labels + memberships with the authoritative
 * server response. Rows that exist in IDB for this workspace but are missing
 * from the response are deleted; rows in the response are upserted. Mirrors
 * the stream-sync / saved-sync reconciliation so labels that were archived
 * while we were offline don't linger in the catalog.
 */
export async function reconcileLabels(
  workspaceId: string,
  labels: Label[],
  memberships: LabelMember[],
  assignments: LabelAssignment[]
): Promise<void> {
  const labelIds = new Set(labels.map((l) => l.id))
  const memberKeys = new Set(memberships.map((m) => membershipId(m.workspaceId, m.labelId, m.userId)))
  const assignmentKeys = new Set(
    assignments.map((a) => assignmentId(a.workspaceId, a.resourceType, a.resourceId, a.labelId, a.userId))
  )

  const existingLabels = await db.labels.where("workspaceId").equals(workspaceId).primaryKeys()
  const existingMembers = await db.labelMemberships.where("workspaceId").equals(workspaceId).primaryKeys()
  const existingAssignments = await db.labelAssignments.where("workspaceId").equals(workspaceId).primaryKeys()

  const labelsToDelete = (existingLabels as string[]).filter((id) => !labelIds.has(id))
  const membersToDelete = (existingMembers as string[]).filter((key) => !memberKeys.has(key))
  const assignmentsToDelete = (existingAssignments as string[]).filter((key) => !assignmentKeys.has(key))

  await db.transaction("rw", db.labels, db.labelMemberships, db.labelAssignments, async () => {
    if (labelsToDelete.length > 0) await db.labels.bulkDelete(labelsToDelete)
    if (membersToDelete.length > 0) await db.labelMemberships.bulkDelete(membersToDelete)
    if (assignmentsToDelete.length > 0) await db.labelAssignments.bulkDelete(assignmentsToDelete)
    if (labels.length > 0) await db.labels.bulkPut(labels.map(labelToCached))
    if (memberships.length > 0) await db.labelMemberships.bulkPut(memberships.map(memberToCached))
    if (assignments.length > 0) await db.labelAssignments.bulkPut(assignments.map(assignmentToCached))
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
      await reconcileLabels(workspaceId, res.labels, res.memberships, res.assignments)
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
  /**
   * The viewer's usable catalog: labels they authored plus public labels they
   * explicitly joined, sorted by name. This is the set offered when applying a
   * label to a resource, and the "Your labels" grid on the catalog page.
   */
  myLabels: CachedLabel[]
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
    const publicLabels = active.filter((l) => l.visibility === Visibilities.PUBLIC).sort(byName)
    const discoverable = publicLabels.filter((l) => l.creatorUserId !== currentUserId && !joinedLabelIds.has(l.id))
    const joinedPublic = publicLabels.filter((l) => l.creatorUserId !== currentUserId && joinedLabelIds.has(l.id))
    const myLabels = [...mine, ...joinedPublic].sort(byName)

    return {
      currentUserId,
      mine,
      myLabels,
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

/** Resolve the current viewer's workspace-scoped user id (UserId), or null. */
function useCurrentWorkspaceUserId(workspaceId: string): string | null {
  const { user } = useAuth()
  const workspaceUsers = useWorkspaceUsers(workspaceId)
  return useMemo(() => {
    if (!user) return null
    return workspaceUsers.find((u) => u.workosUserId === user.id)?.id ?? null
  }, [user, workspaceUsers])
}

export interface ResourceLabelState {
  /** Active (non-archived) labels currently applied to this resource, sorted by name. */
  labels: CachedLabel[]
  /** labelIds applied to this resource — drives the picker's checked state. */
  assignedLabelIds: Set<string>
}

/**
 * Labels the current viewer has applied to one resource. Generic over
 * `resourceType` — a stream today, anything labelable later. Reads the
 * viewer-scoped assignment cache and resolves each `labelId` against the
 * workspace's labels; assignments whose label is gone or archived are dropped
 * (the assignment row may briefly outlive its label after a delete).
 */
export function useResourceLabelAssignments(
  workspaceId: string,
  resourceType: LabelableResourceType,
  resourceId: string
): ResourceLabelState {
  const assignments = useWorkspaceLabelAssignments(workspaceId)
  const labels = useWorkspaceLabels(workspaceId)

  return useMemo(() => {
    const labelById = new Map(labels.map((l) => [l.id, l]))
    const applied: CachedLabel[] = []
    const assignedLabelIds = new Set<string>()
    for (const assignment of assignments) {
      if (assignment.resourceType !== resourceType || assignment.resourceId !== resourceId) continue
      const label = labelById.get(assignment.labelId)
      if (!label || label.archivedAt) continue
      assignedLabelIds.add(label.id)
      applied.push(label)
    }
    applied.sort((a, b) => a.name.localeCompare(b.name))
    return { labels: applied, assignedLabelIds }
  }, [assignments, labels, resourceType, resourceId])
}

export interface AssignLabelInput {
  labelId: string
  resourceType: LabelableResourceType
  resourceId: string
}

export function useAssignLabel(workspaceId: string) {
  const labelService = useLabelService()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: ({ labelId, resourceType, resourceId }: AssignLabelInput) =>
      labelService.assign(workspaceId, labelId, { resourceType, resourceId }),
    onSuccess: (assignment) => {
      void persistAssignment(assignment)
      queryClient.invalidateQueries({ queryKey: labelKeys.list(workspaceId) })
    },
  })
}

export function useUnassignLabel(workspaceId: string) {
  const labelService = useLabelService()
  const queryClient = useQueryClient()
  const currentUserId = useCurrentWorkspaceUserId(workspaceId)

  return useMutation({
    mutationFn: ({ labelId, resourceType, resourceId }: AssignLabelInput) =>
      labelService.unassign(workspaceId, labelId, { resourceType, resourceId }).then(() => ({
        labelId,
        resourceType,
        resourceId,
      })),
    onSuccess: ({ labelId, resourceType, resourceId }) => {
      if (currentUserId) void removeAssignment(workspaceId, resourceType, resourceId, labelId, currentUserId)
      queryClient.invalidateQueries({ queryKey: labelKeys.list(workspaceId) })
    },
  })
}
