import { api } from "./client"
import type { SlotCarrier } from "@/lib/slots"
import type {
  Stream,
  StreamEvent,
  StreamMember,
  StreamType,
  StreamBootstrap,
  EventsAroundResponse,
  EventsAroundDateResponse,
  CreateStreamInput,
  UpdateStreamInput,
  NotificationLevel,
  CompanionMode,
  ToolPrivacyPolicy,
} from "@threa/types"

/**
 * Result shape for the events list endpoint. Carries the raw slot carrier
 * (canonical `slots` and/or the temporary legacy `sharedMessages`) straight
 * from the wire; the slot store is the one write boundary that normalizes it
 * (Amendment A2). Paged-in pointers persist without a full bootstrap refetch.
 */
export interface EventsListResponse extends SlotCarrier {
  events: StreamEvent[]
}

export type { StreamBootstrap, CreateStreamInput, UpdateStreamInput }

export type StreamArchiveStatus = "active" | "archived"

export const streamsApi = {
  async list(workspaceId: string, params?: { type?: StreamType; status?: StreamArchiveStatus[] }): Promise<Stream[]> {
    const searchParams = new URLSearchParams()
    if (params?.type) searchParams.set("stream_type", params.type)
    if (params?.status) {
      params.status.forEach((s) => searchParams.append("status", s))
    }
    const query = searchParams.toString()
    const res = await api.get<{ streams: Stream[] }>(
      `/api/workspaces/${workspaceId}/streams${query ? `?${query}` : ""}`
    )
    return res.streams
  },

  async get(workspaceId: string, streamId: string): Promise<Stream> {
    const res = await api.get<{ stream: Stream }>(`/api/workspaces/${workspaceId}/streams/${streamId}`)
    return res.stream
  },

  async bootstrap(workspaceId: string, streamId: string, params?: { after?: string }): Promise<StreamBootstrap> {
    const searchParams = new URLSearchParams()
    if (params?.after) searchParams.set("after", params.after)
    const query = searchParams.toString()
    const res = await api.get<{ data: StreamBootstrap }>(
      `/api/workspaces/${workspaceId}/streams/${streamId}/bootstrap${query ? `?${query}` : ""}`
    )
    // Raw carrier fields (`slots` / temporary legacy `sharedMessages`) pass
    // through to the write owner; the slot store normalizes them (Amendment A2).
    return res.data
  },

  async create(workspaceId: string, data: CreateStreamInput): Promise<Stream> {
    const res = await api.post<{ stream: Stream }>(`/api/workspaces/${workspaceId}/streams`, data)
    return res.stream
  },

  async update(workspaceId: string, streamId: string, data: UpdateStreamInput): Promise<Stream> {
    const res = await api.patch<{ stream: Stream }>(`/api/workspaces/${workspaceId}/streams/${streamId}`, data)
    return res.stream
  },

  async regenerateTitle(
    workspaceId: string,
    streamId: string,
    sealedName?: { sealedNameCiphertext: string; sealedNameEnvelope: unknown }
  ): Promise<{ stream: Stream; deferred: boolean }> {
    return api.post(`/api/workspaces/${workspaceId}/streams/${streamId}/regenerate-title`, sealedName ?? {})
  },

  async updateCompanionMode(
    workspaceId: string,
    streamId: string,
    data: { companionMode: CompanionMode; companionPersonaId?: string | null }
  ): Promise<Stream> {
    const res = await api.patch<{ stream: Stream }>(
      `/api/workspaces/${workspaceId}/streams/${streamId}/companion`,
      data
    )
    return res.stream
  },

  /**
   * Set (or clear) a scratchpad's tool-privacy policy. `null` clears the
   * restriction; an array (including `[]` = no tools) restricts the agent to
   * those categories. Returns the policy as stored.
   */
  async updateToolPolicy(
    workspaceId: string,
    streamId: string,
    allowedCategories: ToolPrivacyPolicy
  ): Promise<ToolPrivacyPolicy> {
    const res = await api.patch<{ data: { allowedToolCategories: ToolPrivacyPolicy } }>(
      `/api/workspaces/${workspaceId}/streams/${streamId}/tool-policy`,
      { allowedCategories }
    )
    return res.data.allowedToolCategories
  },

  archive(workspaceId: string, streamId: string): Promise<void> {
    return api.post(`/api/workspaces/${workspaceId}/streams/${streamId}/archive`)
  },

  unarchive(workspaceId: string, streamId: string): Promise<void> {
    return api.post(`/api/workspaces/${workspaceId}/streams/${streamId}/unarchive`)
  },

  // Returns the raw slot carrier alongside the events so paged-in pointers
  // persist without waiting for a full bootstrap refetch; the slot store
  // normalizes the carrier (Amendment A2).
  async getEvents(
    workspaceId: string,
    streamId: string,
    params?: { before?: string; after?: string; limit?: number }
  ): Promise<EventsListResponse> {
    const searchParams = new URLSearchParams()
    if (params?.before) searchParams.set("before", params.before)
    if (params?.after) searchParams.set("after", params.after)
    if (params?.limit) searchParams.set("limit", params.limit.toString())
    const query = searchParams.toString()
    return api.get<EventsListResponse>(
      `/api/workspaces/${workspaceId}/streams/${streamId}/events${query ? `?${query}` : ""}`
    )
  },

  async getEventsAround(
    workspaceId: string,
    streamId: string,
    targetId: string,
    limit?: number
  ): Promise<EventsAroundResponse> {
    // The endpoint centers on a message OR a raw timeline event (a non-message
    // row like a delegation card has no messageId); ids are prefix-typed, so
    // route by prefix.
    const searchParams = new URLSearchParams(
      targetId.startsWith("event_") ? { eventId: targetId } : { messageId: targetId }
    )
    if (limit) searchParams.set("limit", limit.toString())
    return api.get<EventsAroundResponse>(
      `/api/workspaces/${workspaceId}/streams/${streamId}/events/around?${searchParams.toString()}`
    )
  },

  /**
   * Jump-to-date: events around the first message on or after `isoDate`, plus
   * the `anchorMessageId` to scroll to (null when the date is past the last
   * message). Shares the `/events/around` endpoint with the id-based jump.
   */
  async getEventsAroundDate(
    workspaceId: string,
    streamId: string,
    isoDate: string,
    limit?: number
  ): Promise<EventsAroundDateResponse> {
    const searchParams = new URLSearchParams({ date: isoDate })
    if (limit) searchParams.set("limit", limit.toString())
    return api.get<EventsAroundDateResponse>(
      `/api/workspaces/${workspaceId}/streams/${streamId}/events/around?${searchParams.toString()}`
    )
  },

  async checkSlugAvailable(workspaceId: string, slug: string, excludeStreamId?: string): Promise<boolean> {
    const params = new URLSearchParams({ slug })
    if (excludeStreamId) params.set("exclude", excludeStreamId)
    const res = await api.get<{ available: boolean }>(
      `/api/workspaces/${workspaceId}/streams/slug-available?${params.toString()}`
    )
    return res.available
  },

  async addMember(workspaceId: string, streamId: string, memberId: string): Promise<StreamMember> {
    const res = await api.post<{ membership: StreamMember }>(
      `/api/workspaces/${workspaceId}/streams/${streamId}/members`,
      { memberId }
    )
    return res.membership
  },

  async removeMember(workspaceId: string, streamId: string, memberId: string): Promise<void> {
    await api.delete(`/api/workspaces/${workspaceId}/streams/${streamId}/members/${memberId}`)
  },

  async setNotificationLevel(
    workspaceId: string,
    streamId: string,
    notificationLevel: NotificationLevel | null
  ): Promise<StreamMember> {
    const res = await api.post<{ membership: StreamMember }>(
      `/api/workspaces/${workspaceId}/streams/${streamId}/notification-level`,
      { notificationLevel }
    )
    return res.membership
  },

  async join(workspaceId: string, streamId: string): Promise<StreamMember> {
    const res = await api.post<{ data: { membership: StreamMember } }>(
      `/api/workspaces/${workspaceId}/streams/${streamId}/join`
    )
    return res.data.membership
  },

  async markAsRead(workspaceId: string, streamId: string, lastEventId: string): Promise<StreamMember | null> {
    const res = await api.post<{ membership: StreamMember | null }>(
      `/api/workspaces/${workspaceId}/streams/${streamId}/read`,
      { lastEventId }
    )
    return res.membership
  },

  async markUnread(workspaceId: string, streamId: string, messageId: string): Promise<StreamMember | null> {
    // Null membership = a successful unread by a viewer with access but no
    // membership row (INV-62) — the standalone frontier moved; there is no
    // membership to return.
    const res = await api.post<{ membership: StreamMember | null }>(
      `/api/workspaces/${workspaceId}/streams/${streamId}/unread`,
      { messageId }
    )
    return res.membership
  },
}
