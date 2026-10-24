import { beforeAll, describe, expect, test } from "bun:test"
import { ShareErrorCodes, type ScheduledMessageView, type UnsharedReferencesResponse } from "@threahq/types"
import {
  TestClient,
  createChannel,
  createWorkspace,
  deleteMessage,
  joinWorkspace,
  loginAs,
  moveMessagesToThread,
  sendMessage,
} from "../client"

type EventsResponse = { sharedMessages: Record<string, { state: string }> }

describe("share privacy on a scheduled send", () => {
  let workspaceId: string
  let alice: TestClient
  let bob: TestClient
  let targetStreamId: string
  const sources: { messageId: string; streamId: string }[] = []

  beforeAll(async () => {
    alice = new TestClient()
    bob = new TestClient()
    await loginAs(alice, "share-scheduled-alice@example.com", "Share Scheduled Alice")
    workspaceId = (await createWorkspace(alice, "Share Scheduled Workspace")).id
    await loginAs(bob, "share-scheduled-bob@example.com", "Share Scheduled Bob")
    await joinWorkspace(bob, workspaceId)

    targetStreamId = (await createChannel(alice, workspaceId, "share-scheduled-target", "public")).id
    for (const slug of ["share-scheduled-private-a", "share-scheduled-private-b"]) {
      const streamId = (await createChannel(alice, workspaceId, slug)).id
      sources.push({ messageId: (await sendMessage(alice, workspaceId, streamId, `source in ${slug}`)).id, streamId })
    }
  })

  function shareContent(...shared: { messageId: string; streamId: string }[]) {
    return { type: "doc", content: shared.map((attrs) => ({ type: "sharedMessage", attrs })) }
  }

  function schedule(confirmedPrivacyWarning?: boolean, shared = [sources[0]!]) {
    return alice.post<{ scheduled: ScheduledMessageView; code?: string }>(`/api/workspaces/${workspaceId}/scheduled`, {
      streamId: targetStreamId,
      contentJson: shareContent(...shared),
      scheduledFor: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      confirmedPrivacyWarning,
    })
  }

  test("asks when scheduling, keeps accepted shares through edits and a reschedule, and records what was consented", async () => {
    const asked = await schedule()
    const confirmed = await schedule(true)
    const id = confirmed.data.scheduled.id
    const kept = await alice.patch<{ scheduled: ScheduledMessageView }>(
      `/api/workspaces/${workspaceId}/scheduled/${id}`,
      {
        contentJson: shareContent(sources[0]!),
        expectedVersion: confirmed.data.scheduled.version,
      }
    )
    const added = await alice.patch<{ code?: string }>(`/api/workspaces/${workspaceId}/scheduled/${id}`, {
      contentJson: shareContent(sources[0]!, sources[1]!),
      expectedVersion: kept.data.scheduled.version,
    })
    const rescheduled = await alice.patch<{ scheduled: ScheduledMessageView }>(
      `/api/workspaces/${workspaceId}/scheduled/${id}`,
      {
        scheduledFor: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
        expectedVersion: kept.data.scheduled.version,
      }
    )
    const sent = await alice.post<{ scheduled: ScheduledMessageView }>(
      `/api/workspaces/${workspaceId}/scheduled/${id}/send-now`
    )
    const seen = await bob.get<EventsResponse>(`/api/workspaces/${workspaceId}/streams/${targetStreamId}/events`)

    expect({
      askedStatus: asked.status,
      askedCode: asked.data.code,
      confirmedStatus: confirmed.status,
      keptStatus: kept.status,
      addedStatus: added.status,
      addedCode: added.data.code,
      rescheduledStatus: rescheduled.status,
      sentStatus: sent.status,
      sentState: sent.data.scheduled.status,
      consented: seen.data.sharedMessages[sources[0]!.messageId]?.state,
    }).toEqual({
      askedStatus: 409,
      askedCode: ShareErrorCodes.PRIVACY_CONFIRMATION_REQUIRED,
      confirmedStatus: 201,
      keptStatus: 200,
      addedStatus: 409,
      addedCode: ShareErrorCodes.PRIVACY_CONFIRMATION_REQUIRED,
      rescheduledStatus: 200,
      sentStatus: 200,
      sentState: "sent",
      consented: "ok",
    })
  })

  test("a source that turns private after scheduling asks again on edit, sends unrecorded, and the author can share it afterwards", async () => {
    const laterPrivateStreamId = (await createChannel(alice, workspaceId, "share-scheduled-later-private", "public")).id
    const laterPrivate = {
      messageId: (await sendMessage(alice, workspaceId, laterPrivateStreamId, "public for now")).id,
      streamId: laterPrivateStreamId,
    }
    const consented = sources[0]!
    const scheduled = await schedule(true, [consented, laterPrivate])
    await alice.patch(`/api/workspaces/${workspaceId}/streams/${laterPrivateStreamId}`, { visibility: "private" })
    const reasked = await alice.patch<{ code?: string }>(
      `/api/workspaces/${workspaceId}/scheduled/${scheduled.data.scheduled.id}`,
      { contentJson: shareContent(consented, laterPrivate), expectedVersion: scheduled.data.scheduled.version }
    )
    const sent = await alice.post<{ scheduled: ScheduledMessageView }>(
      `/api/workspaces/${workspaceId}/scheduled/${scheduled.data.scheduled.id}/send-now`
    )
    const seen = await bob.get<EventsResponse>(`/api/workspaces/${workspaceId}/streams/${targetStreamId}/events`)
    const unshared = await alice.get<UnsharedReferencesResponse>(`/api/workspaces/${workspaceId}/unshared-references`)
    const sentMessageId = sent.data.scheduled.sentMessageId!
    const shareByOther = await bob.post(`/api/workspaces/${workspaceId}/messages/${sentMessageId}/share-references`)
    const shared = await alice.post(`/api/workspaces/${workspaceId}/messages/${sentMessageId}/share-references`)
    const seenAfter = await bob.get<EventsResponse>(`/api/workspaces/${workspaceId}/streams/${targetStreamId}/events`)
    const unsharedAfter = await alice.get<UnsharedReferencesResponse>(
      `/api/workspaces/${workspaceId}/unshared-references`
    )

    expect({
      reaskedCode: reasked.data.code,
      sentState: sent.data.scheduled.status,
      consented: seen.data.sharedMessages[consented.messageId]?.state,
      laterPrivate: seen.data.sharedMessages[laterPrivate.messageId]?.state,
      unshared: unshared.data.references,
      shareByOtherStatus: shareByOther.status,
      sharedStatus: shared.status,
      laterPrivateAfterShare: seenAfter.data.sharedMessages[laterPrivate.messageId]?.state,
      unsharedAfter: unsharedAfter.data.references,
    }).toEqual({
      reaskedCode: ShareErrorCodes.PRIVACY_CONFIRMATION_REQUIRED,
      sentState: "sent",
      consented: "ok",
      laterPrivate: "private",
      unshared: [
        {
          messageId: sentMessageId,
          streamId: targetStreamId,
          sourceMessageId: laterPrivate.messageId,
          flavor: "pointer",
        },
      ],
      shareByOtherStatus: 403,
      sharedStatus: 204,
      laterPrivateAfterShare: "ok",
      unsharedAfter: [],
    })
  })

  test("an unshared reference whose source is deleted stops asking to be shared", async () => {
    const laterPrivateStreamId = (await createChannel(alice, workspaceId, "share-scheduled-deleted-source", "public"))
      .id
    const laterPrivate = {
      messageId: (await sendMessage(alice, workspaceId, laterPrivateStreamId, "deleted later")).id,
      streamId: laterPrivateStreamId,
    }
    const scheduled = await schedule(true, [laterPrivate])
    await alice.patch(`/api/workspaces/${workspaceId}/streams/${laterPrivateStreamId}`, { visibility: "private" })
    const sent = await alice.post<{ scheduled: ScheduledMessageView }>(
      `/api/workspaces/${workspaceId}/scheduled/${scheduled.data.scheduled.id}/send-now`
    )
    const sentMessageId = sent.data.scheduled.sentMessageId!
    const listed = (unshared: UnsharedReferencesResponse) =>
      unshared.references.filter((ref) => ref.messageId === sentMessageId).map((ref) => ref.sourceMessageId)
    const before = await alice.get<UnsharedReferencesResponse>(`/api/workspaces/${workspaceId}/unshared-references`)
    await deleteMessage(alice, workspaceId, laterPrivate.messageId)
    const after = await alice.get<UnsharedReferencesResponse>(`/api/workspaces/${workspaceId}/unshared-references`)

    expect({ before: listed(before.data), after: listed(after.data) }).toEqual({
      before: [laterPrivate.messageId],
      after: [],
    })
  })

  test("a reference that can no longer be shared doesn't block sharing the others", async () => {
    const channelId = (await createChannel(alice, workspaceId, "share-scheduled-moved-source", "public")).id
    const anchor = await sendMessage(alice, workspaceId, channelId, "thread anchor")
    const moved = {
      messageId: (await sendMessage(alice, workspaceId, channelId, "moved later")).id,
      streamId: channelId,
    }
    const kept = { messageId: (await sendMessage(alice, workspaceId, channelId, "stays put")).id, streamId: channelId }
    const scheduled = await schedule(true, [moved, kept])
    await alice.patch(`/api/workspaces/${workspaceId}/streams/${channelId}`, { visibility: "private" })
    const sent = await alice.post<{ scheduled: ScheduledMessageView }>(
      `/api/workspaces/${workspaceId}/scheduled/${scheduled.data.scheduled.id}/send-now`
    )
    const sentMessageId = sent.data.scheduled.sentMessageId!
    await moveMessagesToThread(alice, workspaceId, channelId, anchor.id, [moved.messageId])
    const listed = await alice.get<UnsharedReferencesResponse>(`/api/workspaces/${workspaceId}/unshared-references`)
    const shared = await alice.post(`/api/workspaces/${workspaceId}/messages/${sentMessageId}/share-references`)
    const seen = await bob.get<EventsResponse>(`/api/workspaces/${workspaceId}/streams/${targetStreamId}/events`)

    expect({
      listed: listed.data.references.filter((ref) => ref.messageId === sentMessageId).map((ref) => ref.sourceMessageId),
      sharedStatus: shared.status,
      kept: seen.data.sharedMessages[kept.messageId]?.state,
    }).toEqual({ listed: [kept.messageId], sharedStatus: 204, kept: "ok" })
  })
})
