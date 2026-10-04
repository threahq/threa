import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { Pool } from "pg"
import { WORKSPACE_ROLE_SLUGS, permissionsForRole } from "@threahq/types"
import { createTestPool } from "../integration/setup"
import {
  TestClient,
  addStreamMember,
  createChannel,
  createScratchpad,
  createWorkspace,
  getWorkspaceBootstrap,
  joinWorkspace,
  loginAs,
} from "../client"

const testRunId = Math.random().toString(36).substring(7)

describe("guest workspace bootstrap", () => {
  let pool: Pool

  beforeAll(() => {
    pool = createTestPool()
  })

  afterAll(async () => {
    await pool.end()
  })

  test("should list only guest_public streams and the guest's own streams when a member becomes a guest", async () => {
    const owner = new TestClient()
    const guestClient = new TestClient()
    await loginAs(owner, `guestboot-owner-${testRunId}@test.com`, "Guest Bootstrap Owner")
    await loginAs(guestClient, `guestboot-guest-${testRunId}@test.com`, "Guest Bootstrap Guest")
    const workspace = await createWorkspace(owner, `Guest Bootstrap WS ${testRunId}`)

    const publicChannel = await createChannel(owner, workspace.id, `gb-public-${testRunId}`, "public")
    const openChannel = await createChannel(owner, workspace.id, `gb-open-${testRunId}`, "public")
    const privateChannel = await createChannel(owner, workspace.id, `gb-private-${testRunId}`, "private")
    const sharedChannel = await createChannel(owner, workspace.id, `gb-shared-${testRunId}`, "private")
    const ownerScratchpad = await createScratchpad(owner, workspace.id)
    await pool.query(`UPDATE streams SET visibility = 'guest_public' WHERE workspace_id = $1 AND id = $2`, [
      workspace.id,
      openChannel.id,
    ])

    const guest = await joinWorkspace(guestClient, workspace.id)
    expect((await addStreamMember(owner, workspace.id, sharedChannel.id, guest.id)).status).toBe(201)
    const guestScratchpad = await createScratchpad(guestClient, workspace.id)

    const fixture = { publicChannel, openChannel, privateChannel, sharedChannel, ownerScratchpad, guestScratchpad }
    const visibleTo = async () => {
      const bootstrap = await getWorkspaceBootstrap(guestClient, workspace.id)
      const ids = new Set(bootstrap.streams.map((stream) => stream.id))
      return {
        fixtures: Object.entries(fixture)
          .filter(([, stream]) => ids.has(stream.id))
          .map(([name]) => name),
        viewerPermissions: bootstrap.viewerPermissions,
      }
    }

    const asMember = await visibleTo()
    await pool.query(`UPDATE users SET role = $3 WHERE workspace_id = $1 AND id = $2`, [
      workspace.id,
      guest.id,
      WORKSPACE_ROLE_SLUGS.GUEST,
    ])
    const asGuest = await visibleTo()

    expect({ asMember, asGuest }).toEqual({
      asMember: {
        fixtures: ["publicChannel", "openChannel", "sharedChannel", "guestScratchpad"],
        viewerPermissions: permissionsForRole(WORKSPACE_ROLE_SLUGS.MEMBER),
      },
      asGuest: {
        fixtures: ["openChannel", "sharedChannel", "guestScratchpad"],
        viewerPermissions: permissionsForRole(WORKSPACE_ROLE_SLUGS.GUEST),
      },
    })
  })
})
