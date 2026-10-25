import { beforeAll, describe, expect, test } from "bun:test"
import { privateQuoteAttrs } from "@threahq/prosemirror"
import {
  MessageReferenceErrorCodes,
  ShareErrorCodes,
  type JSONContent,
  type ScheduledMessageView,
  type UnsharedReferencesResponse,
} from "@threahq/types"
import {
  TestClient,
  createChannel,
  createWorkspace,
  deleteMessage,
  joinStream,
  joinWorkspace,
  listEvents,
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

  test("a reference the author can't read right now stays listed and can be shared once access returns", async () => {
    const carol = new TestClient()
    await loginAs(carol, "share-scheduled-carol@example.com", "Share Scheduled Carol")
    const carolUser = await joinWorkspace(carol, workspaceId)
    await joinStream(carol, workspaceId, targetStreamId)
    const [regained, kept] = await Promise.all(
      ["share-scheduled-regained", "share-scheduled-kept"].map(async (slug) => {
        const streamId = (await createChannel(alice, workspaceId, slug, "public")).id
        await joinStream(carol, workspaceId, streamId)
        return { messageId: (await sendMessage(alice, workspaceId, streamId, `source in ${slug}`)).id, streamId }
      })
    )
    const scheduled = await carol.post<{ scheduled: ScheduledMessageView }>(
      `/api/workspaces/${workspaceId}/scheduled`,
      {
        streamId: targetStreamId,
        contentJson: shareContent(regained!, kept!),
        scheduledFor: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        confirmedPrivacyWarning: true,
      }
    )
    for (const { streamId } of [regained!, kept!]) {
      await alice.patch(`/api/workspaces/${workspaceId}/streams/${streamId}`, { visibility: "private" })
    }
    const sent = await carol.post<{ scheduled: ScheduledMessageView }>(
      `/api/workspaces/${workspaceId}/scheduled/${scheduled.data.scheduled.id}/send-now`
    )
    const sentMessageId = sent.data.scheduled.sentMessageId!
    const listed = async () => {
      const unshared = await carol.get<UnsharedReferencesResponse>(`/api/workspaces/${workspaceId}/unshared-references`)
      return unshared.data.references.filter((ref) => ref.messageId === sentMessageId).map((ref) => ref.sourceMessageId)
    }
    const shareAndSee = async () => {
      const shared = await carol.post(`/api/workspaces/${workspaceId}/messages/${sentMessageId}/share-references`)
      const seen = await bob.get<EventsResponse>(`/api/workspaces/${workspaceId}/streams/${targetStreamId}/events`)
      return {
        status: shared.status,
        regained: seen.data.sharedMessages[regained!.messageId]?.state,
        kept: seen.data.sharedMessages[kept!.messageId]?.state,
      }
    }

    await alice.delete(`/api/workspaces/${workspaceId}/streams/${regained!.streamId}/members/${carolUser.id}`)
    const listedWithoutAccess = await listed()
    const sharedWithoutAccess = await shareAndSee()
    await alice.post(`/api/workspaces/${workspaceId}/streams/${regained!.streamId}/members`, { memberId: carolUser.id })
    const listedWithAccess = await listed()
    const sharedWithAccess = await shareAndSee()

    expect({ listedWithoutAccess, sharedWithoutAccess, listedWithAccess, sharedWithAccess }).toEqual({
      listedWithoutAccess: [kept!.messageId],
      sharedWithoutAccess: { status: 204, regained: "private", kept: "ok" },
      listedWithAccess: [regained!.messageId],
      sharedWithAccess: { status: 204, regained: "ok", kept: "ok" },
    })
  })

  test("a reference whose source the author lost before the send still sends, privately: a share can be shared once access returns, a quote stays a private quote", async () => {
    const dave = new TestClient()
    await loginAs(dave, "share-scheduled-dave@example.com", "Share Scheduled Dave")
    const daveUser = await joinWorkspace(dave, workspaceId)
    await joinStream(dave, workspaceId, targetStreamId)
    const sourceStreamId = (await createChannel(alice, workspaceId, "share-scheduled-lost", "public")).id
    const source = {
      messageId: (await sendMessage(alice, workspaceId, sourceStreamId, "source")).id,
      streamId: sourceStreamId,
    }
    const scheduled = await dave.post<{ scheduled: ScheduledMessageView }>(`/api/workspaces/${workspaceId}/scheduled`, {
      streamId: targetStreamId,
      contentJson: shareContent(source),
      scheduledFor: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    })
    const quoted = await dave.post<{ scheduled: ScheduledMessageView }>(`/api/workspaces/${workspaceId}/scheduled`, {
      streamId: targetStreamId,
      contentJson: {
        type: "doc",
        content: [{ type: "quoteReply", attrs: { ...source, authorName: "Alice", snippet: "source" } }],
      },
      scheduledFor: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    })
    await alice.patch(`/api/workspaces/${workspaceId}/streams/${sourceStreamId}`, { visibility: "private" })

    const quoteSent = await dave.post<{ scheduled: ScheduledMessageView }>(
      `/api/workspaces/${workspaceId}/scheduled/${quoted.data.scheduled.id}/send-now`
    )
    const quoteMessageId = quoteSent.data.scheduled.sentMessageId!
    const sent = await dave.post<{ scheduled: ScheduledMessageView }>(
      `/api/workspaces/${workspaceId}/scheduled/${scheduled.data.scheduled.id}/send-now`
    )
    const sentMessageId = sent.data.scheduled.sentMessageId
    const listed = async () => {
      const unshared = await dave.get<UnsharedReferencesResponse>(`/api/workspaces/${workspaceId}/unshared-references`)
      return unshared.data.references.filter((ref) => ref.messageId === sentMessageId).map((ref) => ref.sourceMessageId)
    }
    const seenByBob = async () => {
      const seen = await bob.get<EventsResponse>(`/api/workspaces/${workspaceId}/streams/${targetStreamId}/events`)
      return seen.data.sharedMessages[source.messageId]?.state
    }
    const quoteSeenByBob = async () => {
      const events = await listEvents(bob, workspaceId, targetStreamId, ["message_created", "message_edited"])
      const payload = events.findLast(
        (event) => (event.payload as { messageId?: string }).messageId === quoteMessageId
      )!.payload as { contentJson: JSONContent; contentMarkdown: string }
      return { quote: payload.contentJson.content?.[0], markdown: payload.contentMarkdown }
    }
    const quoteListed = async () => {
      const unshared = await dave.get<UnsharedReferencesResponse>(`/api/workspaces/${workspaceId}/unshared-references`)
      return unshared.data.references.filter((ref) => ref.messageId === quoteMessageId)
    }
    const privateQuote = { type: "quoteReply", attrs: privateQuoteAttrs(source) }
    const quoteSeenWithoutAccess = await quoteSeenByBob()
    const listedWithoutAccess = await listed()
    const seenWithoutAccess = await seenByBob()
    await alice.post(`/api/workspaces/${workspaceId}/streams/${sourceStreamId}/members`, { memberId: daveUser.id })
    const listedWithAccess = await listed()
    const shared = await dave.post(`/api/workspaces/${workspaceId}/messages/${sentMessageId}/share-references`)
    const quoteEdited = await dave.patch(`/api/workspaces/${workspaceId}/messages/${quoteMessageId}`, {
      contentJson: {
        type: "doc",
        content: [privateQuote, { type: "paragraph", content: [{ type: "text", text: "edited" }] }],
      },
    })

    expect({
      quoteSent: { status: quoteSent.status, seen: quoteSeenWithoutAccess },
      quoteEdited: { status: quoteEdited.status, seen: await quoteSeenByBob(), listed: await quoteListed() },
      sent: { status: sent.status, hasMessage: Boolean(sentMessageId) },
      listedWithoutAccess,
      seenWithoutAccess,
      listedWithAccess,
      shared: { status: shared.status, seen: await seenByBob() },
    }).toEqual({
      quoteSent: {
        status: 200,
        seen: {
          quote: privateQuote,
          markdown: `> — [Private quote](quote:${source.streamId}/${source.messageId}?private=1)`,
        },
      },
      quoteEdited: {
        status: 200,
        seen: {
          quote: privateQuote,
          markdown: `> — [Private quote](quote:${source.streamId}/${source.messageId}?private=1)\n\nedited`,
        },
        listed: [],
      },
      sent: { status: 200, hasMessage: true },
      listedWithoutAccess: [],
      seenWithoutAccess: "private",
      listedWithAccess: [source.messageId],
      shared: { status: 204, seen: "ok" },
    })
  })

  test("should reject scheduling or editing in a reference the author can't read, as it rejects a message that doesn't exist", async () => {
    const erin = new TestClient()
    await loginAs(erin, "share-scheduled-erin@example.com", "Share Scheduled Erin")
    await joinWorkspace(erin, workspaceId)
    await joinStream(erin, workspaceId, targetStreamId)
    const unreadable = sources[0]!
    const missing = { messageId: "msg_01JZZZZZZZZZZZZZZZZZZZZZZZ", streamId: unreadable.streamId }
    const quote = (ref: { messageId: string; streamId: string }) => ({
      type: "doc",
      content: [{ type: "quoteReply", attrs: { ...ref, authorName: "Alice", snippet: "guess" } }],
    })
    const create = (contentJson: JSONContent) =>
      erin.post<{ code?: string }>(`/api/workspaces/${workspaceId}/scheduled`, {
        streamId: targetStreamId,
        contentJson,
        scheduledFor: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      })
    const plain = await erin.post<{ scheduled: ScheduledMessageView }>(`/api/workspaces/${workspaceId}/scheduled`, {
      streamId: targetStreamId,
      contentJson: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "draft" }] }] },
      scheduledFor: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    })
    const edited = await erin.patch<{ code?: string }>(
      `/api/workspaces/${workspaceId}/scheduled/${plain.data.scheduled.id}`,
      { contentJson: quote(unreadable), expectedVersion: plain.data.scheduled.version }
    )
    const results = await Promise.all([
      create(quote(unreadable)),
      create(shareContent(unreadable)),
      create(quote(missing)),
    ])

    expect({
      created: results.map((r) => ({ status: r.status, code: r.data.code })),
      edited: { status: edited.status, code: edited.data.code },
    }).toEqual({
      created: Array(3).fill({ status: 400, code: MessageReferenceErrorCodes.SOURCE_NOT_FOUND }),
      edited: { status: 400, code: MessageReferenceErrorCodes.SOURCE_NOT_FOUND },
    })
  })
})
