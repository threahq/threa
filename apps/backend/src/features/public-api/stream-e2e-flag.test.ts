/**
 * `GET /streams/{id}` reports sealed-ness so a client knows before it composes.
 *
 * Without the flag the only way to learn a stream is encrypted is to post a
 * plaintext body and be rejected by the INV-E1 write gate — by which point the
 * plaintext has already crossed the wire. The field exists to keep that from
 * being the discovery mechanism.
 */

import { afterEach, describe, expect, it, mock, spyOn } from "bun:test"
import type { Request, Response } from "express"
import { createPublicApiHandlers, type PublicApiDeps } from "./handlers"
import { StreamRepository } from "../streams"
import type { StreamService } from "../streams"

function createResponse(): { res: Response; getBody: () => Record<string, unknown> } {
  let body: unknown
  const res = {} as Response
  res.status = mock(() => res) as unknown as Response["status"]
  res.json = mock((payload: unknown) => {
    body = payload
    return res
  }) as unknown as Response["json"]
  return { res, getBody: () => body as Record<string, unknown> }
}

function fakeStream(overrides: Record<string, unknown> = {}) {
  return {
    id: "stream_1",
    workspaceId: "ws_1",
    type: "scratchpad",
    displayName: "Notes",
    slug: null,
    description: null,
    descriptionJson: null,
    visibility: "private",
    parentStreamId: null,
    parentAnchorId: null,
    rootStreamId: null,
    companionMode: "off",
    companionPersonaId: null,
    memoryMode: "auto",
    createdBy: "usr_1",
    createdAt: new Date("2026-09-19T10:00:00.000Z"),
    updatedAt: new Date("2026-09-19T10:00:00.000Z"),
    archivedAt: null,
    ...overrides,
  }
}

function createHandlers() {
  const deps: PublicApiDeps = {
    eventService: {} as PublicApiDeps["eventService"],
    streamService: {
      tryAccess: mock(() => Promise.resolve(fakeStream())),
    } as unknown as StreamService,
    searchService: {} as PublicApiDeps["searchService"],
    featureFlagService: {} as PublicApiDeps["featureFlagService"],
    memoExplorerService: {} as PublicApiDeps["memoExplorerService"],
    attachmentService: {} as PublicApiDeps["attachmentService"],
    botChannelService: {} as PublicApiDeps["botChannelService"],
    botRuntimeService: {} as PublicApiDeps["botRuntimeService"],
    labelService: {} as PublicApiDeps["labelService"],
    labelAssignmentService: {} as PublicApiDeps["labelAssignmentService"],
    pool: {} as PublicApiDeps["pool"],
    io: {} as PublicApiDeps["io"],
  }
  return createPublicApiHandlers(deps)
}

function userRequest(): Request {
  return {
    workspaceId: "ws_1",
    params: { streamId: "stream_1" },
    userApiKey: { id: "key_1" },
    user: { id: "usr_1", name: "Tester" },
  } as unknown as Request
}

describe("public API getStream and end-to-end encryption", () => {
  afterEach(() => mock.restore())

  it("marks an encrypted stream as e2eEnabled", async () => {
    spyOn(StreamRepository, "findById").mockResolvedValue(
      fakeStream({ e2eEnabled: true, e2eOwnerKeyId: "e2ek_1" }) as never
    )

    const { res, getBody } = createResponse()
    await createHandlers().getStream(userRequest(), res)

    expect(getBody().data).toMatchObject({ id: "stream_1", e2eEnabled: true })
  })

  it("leaves the flag off a plaintext stream rather than sending false", async () => {
    spyOn(StreamRepository, "findById").mockResolvedValue(fakeStream() as never)

    const { res, getBody } = createResponse()
    await createHandlers().getStream(userRequest(), res)

    expect(getBody().data).not.toHaveProperty("e2eEnabled")
  })
})
