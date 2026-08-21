import { useMemo } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import { useLabelService } from "@/contexts"
import { db, type CachedLabel, type CachedLabelAssignment, type CachedStream } from "@/db"
import { useWorkspaceLabels, useWorkspaceLabelAssignments, useWorkspaceStreams } from "@/stores/workspace-store"
import { useCurrentWorkspaceUserId } from "./use-current-workspace-user-id"
import { LabelableResourceTypes } from "@threa/types"
import { isHiddenStreamType } from "@/lib/streams"
import type {
  CreateLabelInput,
  Label,
  LabelAssignment,
  LabelableResourceType,
  LabeledMessage,
  UpdateLabelInput,
} from "@threa/types"

export type { CachedLabel, CachedLabelAssignment }

export const labelKeys = {
  all: ["labels"] as const,
  list: (workspaceId: string) => ["labels", workspaceId] as const,
  messages: (workspaceId: string, labelId: string) => ["labels", workspaceId, labelId, "messages"] as const,
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
    actorType: assignment.actorType,
    userId: assignment.userId,
    assignedAt: assignment.assignedAt,
    _cachedAt: Date.now(),
  }
}

function labelToCached(label: Label): CachedLabel {
  return {
    id: label.id,
    workspaceId: label.workspaceId,
    creatorActorType: label.creatorActorType,
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

async function persistLabel(label: Label): Promise<void> {
  await db.labels.put(labelToCached(label))
}

async function removeLabel(_workspaceId: string, labelId: string): Promise<void> {
  await db.labels.delete(labelId)
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
 * Reconcile the workspace's cached labels + assignments with the authoritative
 * server response. Rows that exist in IDB for this workspace but are missing
 * from the response are deleted; rows in the response are upserted. Mirrors the
 * stream-sync / saved-sync reconciliation so labels archived while we were
 * offline don't linger in the catalog.
 *
 * `staleBefore` guards against a `label:*` socket write that lands while the
 * HTTP snapshot is in flight: only rows cached before the fetch started are
 * pruned, so a newer socket-written row the snapshot can't know about survives
 * (same `_cachedAt < cutoff` rule the bootstrap stale-sweep uses).
 */
export async function reconcileLabels(
  workspaceId: string,
  labels: Label[],
  assignments: LabelAssignment[],
  staleBefore = Date.now()
): Promise<void> {
  const labelIds = new Set(labels.map((l) => l.id))
  const assignmentKeys = new Set(
    assignments.map((a) => assignmentId(a.workspaceId, a.resourceType, a.resourceId, a.labelId, a.userId))
  )

  const existingLabels = await db.labels.where("workspaceId").equals(workspaceId).toArray()
  const existingAssignments = await db.labelAssignments.where("workspaceId").equals(workspaceId).toArray()

  const labelsToDelete = existingLabels
    .filter((row) => row._cachedAt < staleBefore && !labelIds.has(row.id))
    .map((row) => row.id)
  const assignmentsToDelete = existingAssignments
    .filter((row) => row._cachedAt < staleBefore && !assignmentKeys.has(row.id))
    .map((row) => row.id)

  await db.transaction("rw", db.labels, db.labelAssignments, async () => {
    if (labelsToDelete.length > 0) await db.labels.bulkDelete(labelsToDelete)
    if (assignmentsToDelete.length > 0) await db.labelAssignments.bulkDelete(assignmentsToDelete)
    if (labels.length > 0) await db.labels.bulkPut(labels.map(labelToCached))
    if (assignments.length > 0) await db.labelAssignments.bulkPut(assignments.map(assignmentToCached))
  })
}

/**
 * Refresh-on-mount server fetch. The render source is always IDB via the
 * workspace store; this background fetch keeps it warm and reconciles entries
 * created/archived while we were offline. Labels are part of the workspace
 * bootstrap, so first paint never blocks on this. Returns the query so a detail
 * view can tell "still settling" apart from "genuinely absent" (a cold
 * deep-link lands before bootstrap populates the cache).
 */
export function useLabelsSync(workspaceId: string) {
  const labelService = useLabelService()

  return useQuery({
    queryKey: labelKeys.list(workspaceId),
    queryFn: async () => {
      const fetchStartedAt = Date.now()
      const res = await labelService.list(workspaceId)
      await reconcileLabels(workspaceId, res.labels, res.assignments, fetchStartedAt)
      return res
    },
    staleTime: Infinity,
    refetchOnMount: true,
    refetchOnWindowFocus: false,
    // Explicit false (the v5 default is true): with staleTime Infinity a
    // reconnect refetch only ever fires for a query invalidated while offline,
    // and the only invalidators of this key are the label mutations below —
    // which can't run offline. Reconnect healing lives elsewhere: active-mode
    // catch-up replays `label:*` events through the gate-registered
    // workspace-sync handlers, the same path that heals every other
    // workspace-scoped projection into IDB (the render source).
    refetchOnReconnect: false,
    enabled: !!workspaceId,
  })
}

export interface LabelViewerContext {
  /** Workspace-scoped user id (UserId) of the current viewer. */
  currentUserId: string | null
  /** The viewer's active labels, sorted by name. This is the whole catalog. */
  myLabels: CachedLabel[]
}

/** The viewer's labels for the catalog page and the picker. */
export function useLabelsView(workspaceId: string): LabelViewerContext {
  const labels = useWorkspaceLabels(workspaceId)
  const currentUserId = useCurrentWorkspaceUserId(workspaceId)

  return useMemo(() => {
    const myLabels = labels.filter((l) => !l.archivedAt).sort((a, b) => a.name.localeCompare(b.name))
    return { currentUserId, myLabels }
  }, [labels, currentUserId])
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

export interface ResourceLabelState {
  /** Active (non-archived) labels applied to this resource by the viewer, sorted by name. */
  labels: CachedLabel[]
  /** labelIds the viewer applied to this resource — drives the picker's checked state. */
  myLabelIds: Set<string>
}

/**
 * Labels applied to one resource. Generic over `resourceType` — a stream today,
 * anything labelable later. Assignments are owner-scoped, so this is the
 * viewer's own set. Assignments whose label is gone or archived are dropped (a
 * row may briefly outlive its label after a delete).
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
    const myLabelIds = new Set<string>()
    for (const assignment of assignments) {
      if (assignment.resourceType !== resourceType || assignment.resourceId !== resourceId) continue
      const label = labelById.get(assignment.labelId)
      if (!label || label.archivedAt) continue
      if (!myLabelIds.has(label.id)) applied.push(label)
      myLabelIds.add(label.id)
    }
    applied.sort((a, b) => a.name.localeCompare(b.name))
    return { labels: applied, myLabelIds }
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
    // The picker isn't optimistic — on failure nothing is written, so without
    // this the box just silently snaps back. Surface it instead of swallowing.
    onError: () => toast.error("Failed to apply label"),
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
    onError: () => toast.error("Failed to remove label"),
  })
}

/** Most recent activity wins: last message, else stream creation (mirrors the sidebar's "activity" sort). */
function streamActivityTime(stream: CachedStream): number {
  return new Date(stream.lastMessagePreview?.createdAt ?? stream.createdAt).getTime()
}

/**
 * The streams carrying a label, newest activity first. Pure so it's unit-tested
 * directly (INV-39). Mirrors the sidebar label section: a stream matches when an
 * assignment row ties it to this label; archived streams and assignment rows for
 * other resource types are dropped. Threads are streams, so a labeled thread
 * surfaces here exactly like any other stream — the landing page is the one
 * place that lists them together.
 */
export function selectLabelStreams(
  assignments: CachedLabelAssignment[],
  streams: CachedStream[],
  labelId: string
): CachedStream[] {
  const streamIds = new Set<string>()
  for (const assignment of assignments) {
    if (assignment.resourceType !== LabelableResourceTypes.STREAM) continue
    if (assignment.labelId === labelId) streamIds.add(assignment.resourceId)
  }
  if (streamIds.size === 0) return []
  return streams
    .filter((stream) => streamIds.has(stream.id) && !stream.archivedAt && !isHiddenStreamType(stream))
    .sort((a, b) => streamActivityTime(b) - streamActivityTime(a))
}

/**
 * The stream ids carrying ANY of `labelIds` (the viewer's own assignments —
 * labels are owner-scoped). Pure; the board's label filters resolve their
 * selection to streams through this, so the client predicate reads the same
 * assignment rows the server's `boardLabelMatchSql` joins. Returns null when no
 * labels are selected so callers can tell "no label filter" from "labels
 * selected but nothing labeled" (which must match NOTHING, not everything).
 */
export function selectLabeledStreamIds(assignments: CachedLabelAssignment[], labelIds: string[]): Set<string> | null {
  if (labelIds.length === 0) return null
  const wanted = new Set(labelIds)
  const streamIds = new Set<string>()
  for (const assignment of assignments) {
    if (assignment.resourceType !== LabelableResourceTypes.STREAM) continue
    if (wanted.has(assignment.labelId)) streamIds.add(assignment.resourceId)
  }
  return streamIds
}

/**
 * Streams in a label, for the label landing page. Reads the same caches the
 * sidebar label section does (assignments ∩ workspace streams), so the page and
 * the sidebar can never disagree, and it stays live through the
 * `label:assigned/unassigned` socket handlers with no extra fetch.
 */
export function useLabelStreams(workspaceId: string, labelId: string): CachedStream[] {
  const assignments = useWorkspaceLabelAssignments(workspaceId)
  const streams = useWorkspaceStreams(workspaceId)
  return useMemo(() => selectLabelStreams(assignments, streams, labelId), [assignments, streams, labelId])
}

/**
 * The messages filed under a label, hydrated server-side (content, reactions,
 * attachments, link previews) for the label landing page's Messages section.
 *
 * Unlike streams, messages aren't fully cached client-side, so this is a real
 * fetch rather than a cache projection. The assign/unassign mutations invalidate
 * `["labels", workspaceId]`, which prefix-covers this key — so labeling a message
 * from anywhere refreshes the list without extra wiring.
 */
export function useLabelMessages(workspaceId: string, labelId: string) {
  const labelService = useLabelService()
  return useQuery<LabeledMessage[]>({
    queryKey: labelKeys.messages(workspaceId, labelId),
    queryFn: () => labelService.listMessages(workspaceId, labelId),
    enabled: !!workspaceId && !!labelId,
    staleTime: 30_000,
  })
}
