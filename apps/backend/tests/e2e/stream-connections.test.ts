import { beforeAll, describe, expect, test } from "bun:test"
import { streamConnectionId } from "@threahq/backend-common"
import type { StreamConnectionSnapshot } from "@threahq/types"
import { TestClient, createChannel, createWorkspace, joinWorkspace, loginAs } from "../client"

const testRunId = Math.random().toString(36).substring(7)

describe("Stream connections E2E", () => {
  let owner: TestClient
  let member: TestClient
  let workspaceId: string
  let channelId: string

  beforeAll(async () => {
    owner = new TestClient()
    member = new TestClient()
    await loginAs(owner, `strconn-owner-${testRunId}@test.com`, "Connect Owner")
    workspaceId = (await createWorkspace(owner, `Connect WS ${testRunId}`)).id
    channelId = (await createChannel(owner, workspaceId, `connect-${testRunId}`)).id
    await loginAs(member, `strconn-member-${testRunId}@test.com`, "Connect Member")
    await joinWorkspace(member, workspaceId, "member")
  })

  test("should refuse every share action to a workspace member who isn't an admin", async () => {
    const base = `/api/workspaces/${workspaceId}`
    const responses = await Promise.all([
      member.get(`${base}/streams/${channelId}/connections`),
      member.post(`${base}/streams/${channelId}/connection-invites`, {}),
      member.post(`${base}/stream-connections/${streamConnectionId()}/revoke`, {}),
      member.post(`${base}/stream-connections/accept`, { token: "tok", visibility: "private" }),
    ])

    expect(responses.map((r) => r.status)).toEqual([403, 403, 403, 403])
  })

  test("should accept a valid snapshot, ignore unknown keys, and reject a malformed one on the internal sync endpoint", async () => {
    const snapshot: StreamConnectionSnapshot = {
      id: streamConnectionId(),
      revision: 1,
      state: "invited",
      hostWorkspaceId: workspaceId,
      hostWorkspaceName: `Connect WS ${testRunId}`,
      hostRegion: "local",
      hostStreamId: channelId,
      hostStreamSlug: `connect-${testRunId}`,
      hostStreamDisplayName: null,
      partnerWorkspaceId: null,
      partnerWorkspaceName: null,
      partnerRegion: null,
      partnerVisibility: null,
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    }

    const [valid, newerControlPlane, malformed] = await Promise.all([
      owner.internalRequest("POST", "/internal/stream-connections", snapshot),
      owner.internalRequest("POST", "/internal/stream-connections", {
        ...snapshot,
        id: streamConnectionId(),
        fieldFromNewerControlPlane: true,
      }),
      owner.internalRequest("POST", "/internal/stream-connections", { ...snapshot, revision: "one" }),
    ])

    expect({ valid: valid.status, newerControlPlane: newerControlPlane.status, malformed: malformed.status }).toEqual({
      valid: 204,
      newerControlPlane: 204,
      malformed: 400,
    })
  })
})
