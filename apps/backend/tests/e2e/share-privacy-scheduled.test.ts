import { beforeAll, describe, expect, test } from "bun:test"
import { ShareErrorCodes, type ScheduledMessageView } from "@threahq/types"
import { TestClient, createChannel, createWorkspace, joinWorkspace, loginAs, sendMessage } from "../client"

describe("share privacy on a scheduled send", () => {
  let workspaceId: string
  let alice: TestClient
  let targetStreamId: string
  const sources: { messageId: string; streamId: string }[] = []

  beforeAll(async () => {
    alice = new TestClient()
    const bob = new TestClient()
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

  function schedule(confirmedPrivacyWarning?: boolean) {
    return alice.post<{ scheduled: ScheduledMessageView; code?: string }>(`/api/workspaces/${workspaceId}/scheduled`, {
      streamId: targetStreamId,
      contentJson: shareContent(sources[0]!),
      scheduledFor: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      confirmedPrivacyWarning,
    })
  }

  test("asks when scheduling, keeps accepted shares on edit, and sends what was consented", async () => {
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
    const sent = await alice.post<{ scheduled: ScheduledMessageView }>(
      `/api/workspaces/${workspaceId}/scheduled/${id}/send-now`
    )

    expect({
      askedStatus: asked.status,
      askedCode: asked.data.code,
      confirmedStatus: confirmed.status,
      keptStatus: kept.status,
      addedStatus: added.status,
      addedCode: added.data.code,
      sentStatus: sent.status,
      sentState: sent.data.scheduled.status,
    }).toEqual({
      askedStatus: 409,
      askedCode: ShareErrorCodes.PRIVACY_CONFIRMATION_REQUIRED,
      confirmedStatus: 201,
      keptStatus: 200,
      addedStatus: 409,
      addedCode: ShareErrorCodes.PRIVACY_CONFIRMATION_REQUIRED,
      sentStatus: 200,
      sentState: "sent",
    })
  })
})
