import { beforeAll, describe, expect, test } from "bun:test"
import { ShareErrorCodes } from "@threahq/types"
import { TestClient, createChannel, createWorkspace, joinWorkspace, listStreams, loginAs, sendMessage } from "../client"

describe("share privacy into a first DM message", () => {
  let workspaceId: string
  let alice: TestClient
  let bobId: string
  let sourceStreamId: string
  let sourceMessageId: string

  beforeAll(async () => {
    alice = new TestClient()
    const bob = new TestClient()
    await loginAs(alice, "share-dm-alice@example.com", "Share DM Alice")
    workspaceId = (await createWorkspace(alice, "Share DM Workspace")).id
    await loginAs(bob, "share-dm-bob@example.com", "Share DM Bob")
    bobId = (await joinWorkspace(bob, workspaceId)).id

    sourceStreamId = (await createChannel(alice, workspaceId, "share-dm-private")).id
    sourceMessageId = (await sendMessage(alice, workspaceId, sourceStreamId, "the source")).id
  })

  function shareToBob(confirmedPrivacyWarning?: boolean) {
    return alice.post<{ code?: string }>(`/api/workspaces/${workspaceId}/messages`, {
      dmUserId: bobId,
      contentJson: {
        type: "doc",
        content: [{ type: "sharedMessage", attrs: { messageId: sourceMessageId, streamId: sourceStreamId } }],
      },
      confirmedPrivacyWarning,
    })
  }

  test("asks before creating the DM, then creates it once confirmed", async () => {
    const asked = await shareToBob()
    const dmsAfterAsk = await listStreams(alice, workspaceId, ["dm"])
    const confirmed = await shareToBob(true)
    const dmsAfterConfirm = await listStreams(alice, workspaceId, ["dm"])

    expect({
      askedStatus: asked.status,
      askedCode: asked.data.code,
      dmsAfterAsk: dmsAfterAsk.length,
      confirmedStatus: confirmed.status,
      dmsAfterConfirm: dmsAfterConfirm.length,
    }).toEqual({
      askedStatus: 409,
      askedCode: ShareErrorCodes.PRIVACY_CONFIRMATION_REQUIRED,
      dmsAfterAsk: 0,
      confirmedStatus: 201,
      dmsAfterConfirm: 1,
    })
  })
})
