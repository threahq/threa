import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { Pool } from "pg"
import { AuthoredByKinds, KnowledgeTypes, MemoTypes, WORKSPACE_ROLE_SLUGS, type AuthoredByKind } from "@threahq/types"
import { FeatureFlagOverrideRepository } from "../../src/features/feature-flags"
import { MemoRepository } from "../../src/features/memos"
import { memoId } from "../../src/lib/id"
import {
  TestClient,
  createChannel,
  createWorkspace,
  getBaseUrl,
  joinWorkspace,
  loginAs,
  sendMessage,
  type WorkspaceUser,
} from "../client"
import { createTestPool } from "../integration/setup"

const testRunId = Math.random()
  .toString(36)
  .replace(/[^a-z0-9]/g, "")

type Room = "open" | "pub"
type Principal = "member" | "guest"

interface FixtureSpec {
  kind: AuthoredByKind
  sources: Room[] | null
  requiresBrowse: boolean
  capturedIn: Room
}

const FIXTURES = {
  agentOpen: { kind: AuthoredByKinds.AGENT, sources: ["open"], requiresBrowse: false, capturedIn: "open" },
  agentPub: { kind: AuthoredByKinds.AGENT, sources: ["pub"], requiresBrowse: false, capturedIn: "pub" },
  agentMixed: { kind: AuthoredByKinds.AGENT, sources: ["open", "pub"], requiresBrowse: false, capturedIn: "open" },
  agentMarked: { kind: AuthoredByKinds.AGENT, sources: ["open"], requiresBrowse: true, capturedIn: "open" },
  agentLegacy: { kind: AuthoredByKinds.AGENT, sources: null, requiresBrowse: false, capturedIn: "open" },
  pipelineOpen: { kind: AuthoredByKinds.PIPELINE, sources: null, requiresBrowse: false, capturedIn: "open" },
} as const satisfies Record<string, FixtureSpec>

type FixtureName = keyof typeof FIXTURES

const FIXTURE_NAMES = Object.keys(FIXTURES) as FixtureName[]
const SHARED_WORD = `audiencequokka${testRunId}`
const uniqueWord = (name: FixtureName) => `${name.toLowerCase()}${testRunId}`

const EXPECTED_VISIBLE = {
  member: [...FIXTURE_NAMES].sort(),
  guest: ["agentOpen", "pipelineOpen"],
}

interface MemoHit {
  memo: { id: string }
}

describe("memo audience over HTTP", () => {
  let pool: Pool
  let workspaceId: string
  let clients: Record<Principal, TestClient>
  let userKeys: Record<Principal, string>
  let idByName: Record<FixtureName, string>
  let nonexistentMemoId: string

  const namesOf = (memoIds: string[]) => {
    const nameById = new Map(FIXTURE_NAMES.map((name) => [idByName[name], name]))
    return memoIds.map((id) => nameById.get(id) ?? id).sort()
  }

  const eachPrincipal = async (memoIdsFor: (principal: Principal) => Promise<string[]>) => ({
    member: namesOf(await memoIdsFor("member")),
    guest: namesOf(await memoIdsFor("guest")),
  })

  const openById = async (statusOf: (principal: Principal, id: string) => Promise<number>) => {
    const statuses = new Set<number>()
    const ids = [...FIXTURE_NAMES.map((name) => idByName[name]), nonexistentMemoId]
    const readable = await eachPrincipal(async (principal) => {
      const answers = await Promise.all(ids.map(async (id) => ({ id, status: await statusOf(principal, id) })))
      for (const { status } of answers) if (status !== 200) statuses.add(status)
      return answers.filter(({ status }) => status === 200).map(({ id }) => id)
    })
    return { ...readable, hiddenStatuses: [...statuses] }
  }

  const explorerSearch = async (principal: Principal, body: Record<string, unknown>) => {
    const { status, data } = await clients[principal].post<{ results: MemoHit[] }>(
      `/api/workspaces/${workspaceId}/memos/search`,
      body
    )
    if (status !== 200) throw new Error(`Memo search failed (${status}): ${JSON.stringify(data)}`)
    return data.results.map((hit) => hit.memo.id)
  }

  const publicApi = async (principal: Principal, method: "GET" | "POST", path: string, body?: unknown) => {
    const response = await fetch(`${getBaseUrl()}/api/v1/workspaces/${workspaceId}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${userKeys[principal]}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    })
    return { status: response.status, body: (await response.json()) as { data: MemoHit[] } }
  }

  beforeAll(async () => {
    pool = createTestPool()

    const login = async (label: string) => {
      const client = new TestClient()
      const workos = await loginAs(client, `memoaud-${label}-${testRunId}@test.com`, `Memo Audience ${label}`)
      return { client, workosUserId: workos.id }
    }
    const owner = await login("owner")
    const memberLogin = await login("member")
    const guestLogin = await login("guest")
    clients = { member: memberLogin.client, guest: guestLogin.client }

    workspaceId = (await createWorkspace(owner.client, `Memo Audience WS ${testRunId}`)).id
    const memberUser = await joinWorkspace(clients.member, workspaceId)
    const guestUser = await joinWorkspace(clients.guest, workspaceId)

    const pub = await createChannel(owner.client, workspaceId, `memoaud-pub-${testRunId}`, "public")
    const open = await createChannel(owner.client, workspaceId, `memoaud-open-${testRunId}`, "public")
    const streamIds: Record<Room, string> = { pub: pub.id, open: open.id }
    await pool.query(`UPDATE streams SET visibility = 'guest_public' WHERE workspace_id = $1 AND id = $2`, [
      workspaceId,
      open.id,
    ])
    await pool.query(`UPDATE users SET role = $3 WHERE workspace_id = $1 AND id = $2`, [
      workspaceId,
      guestUser.id,
      WORKSPACE_ROLE_SLUGS.GUEST,
    ])
    await FeatureFlagOverrideRepository.replaceForSubject(pool, workspaceId, "workspace", workspaceId, { search: "on" })

    const capturedMessages: Record<Room, Awaited<ReturnType<typeof sendMessage>>> = {
      pub: await sendMessage(owner.client, workspaceId, pub.id, "Captured in the public channel"),
      open: await sendMessage(owner.client, workspaceId, open.id, "Captured in the guest-public channel"),
    }

    idByName = {} as Record<FixtureName, string>
    for (const name of FIXTURE_NAMES) {
      const spec: FixtureSpec = FIXTURES[name]
      const message = capturedMessages[spec.capturedIn]
      idByName[name] = memoId()
      await MemoRepository.insert(pool, {
        id: idByName[name],
        workspaceId,
        memoType: MemoTypes.MESSAGE,
        sourceMessageId: message.id,
        title: `Audience ${name}`,
        abstract: `${SHARED_WORD} ${uniqueWord(name)} decided in the ${spec.capturedIn} channel.`,
        sourceMessageIds: [message.id],
        participantIds: [message.authorId],
        knowledgeType: KnowledgeTypes.DECISION,
        authoredByKind: spec.kind,
        requiresBrowse: spec.requiresBrowse,
        ...(spec.sources ? { sourceStreamIds: spec.sources.map((room) => streamIds[room]) } : {}),
      })
    }
    nonexistentMemoId = memoId()

    // User-key auth 401s OWNER_INACTIVE without a mirror row; the e2e harness has no control plane to write one.
    const principals: [WorkspaceUser, string][] = [
      [memberUser, WORKSPACE_ROLE_SLUGS.MEMBER],
      [guestUser, WORKSPACE_ROLE_SLUGS.GUEST],
    ]
    for (const [user, role] of principals) {
      await pool.query(
        `INSERT INTO workspace_user_permissions (workspace_id, workos_user_id, role_slugs, status, last_event_at)
         VALUES ($1, $2, $3, 'active', now())`,
        [workspaceId, user.workosUserId, [role]]
      )
    }
    const mintKey = async (client: TestClient) => {
      const response = await client.post<{ value: string }>(`/api/workspaces/${workspaceId}/user-api-keys`, {
        name: `memo-audience-${testRunId}`,
        scopes: ["memos:read"],
      })
      if (response.status !== 201) {
        throw new Error(`Create user key failed (${response.status}): ${JSON.stringify(response.data)}`)
      }
      return response.data.value
    }
    userKeys = { member: await mintKey(clients.member), guest: await mintKey(clients.guest) }
  })

  afterAll(async () => {
    await pool.end()
  })

  test("should list only the memos a reader can read in the memory explorer when searching a shared word", async () => {
    expect(await eachPrincipal((principal) => explorerSearch(principal, { query: SHARED_WORD }))).toEqual(
      EXPECTED_VISIBLE
    )
  })

  test("should list only the memos a reader can read in the memory explorer when the search is an exact phrase", async () => {
    expect(await eachPrincipal((principal) => explorerSearch(principal, { query: `"${SHARED_WORD}"` }))).toEqual(
      EXPECTED_VISIBLE
    )
  })

  test("should list only the memos a reader can read in the memory explorer when browsing without a query", async () => {
    expect(await eachPrincipal((principal) => explorerSearch(principal, {}))).toEqual(EXPECTED_VISIBLE)
  })

  test("should answer a hidden memo with the not-found a nonexistent id gets when a reader opens it by id", async () => {
    const opened = await openById(
      async (principal, id) => (await clients[principal].get(`/api/workspaces/${workspaceId}/memos/${id}`)).status
    )

    expect(opened).toEqual({ ...EXPECTED_VISIBLE, hiddenStatuses: [404] })
  })

  test("should list only the memos a reader can read in unified search when each memo's own word is searched", async () => {
    // The unified search caps its memo leg at a handful, so each memo is probed by its own word.
    const readable = await eachPrincipal(async (principal) => {
      const probes = await Promise.all(
        FIXTURE_NAMES.map(async (name) => {
          const { status, data } = await clients[principal].post<{ memos: MemoHit[] }>(
            `/api/workspaces/${workspaceId}/search`,
            { query: uniqueWord(name) }
          )
          if (status !== 200) throw new Error(`Unified search failed (${status}): ${JSON.stringify(data)}`)
          return data.memos.map((hit) => hit.memo.id)
        })
      )
      return probes.flat()
    })

    expect(readable).toEqual(EXPECTED_VISIBLE)
  })

  test("should list only the memos a reader can read in the public API when a user key searches memos", async () => {
    const readable = await eachPrincipal(async (principal) => {
      const { status, body } = await publicApi(principal, "POST", "/memos/search", { query: SHARED_WORD })
      if (status !== 200) throw new Error(`Public memo search failed (${status}): ${JSON.stringify(body)}`)
      return body.data.map((hit) => hit.memo.id)
    })

    expect(readable).toEqual(EXPECTED_VISIBLE)
  })

  test("should answer a hidden memo with the not-found a nonexistent id gets when a user key reads it from the public API", async () => {
    const opened = await openById(async (principal, id) => (await publicApi(principal, "GET", `/memos/${id}`)).status)

    expect(opened).toEqual({ ...EXPECTED_VISIBLE, hiddenStatuses: [404] })
  })
})
