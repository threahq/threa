import { describe, expect, it, mock } from "bun:test"
import { Readable } from "node:stream"
import { AvatarService } from "./avatar-service"
import type { StorageProvider } from "../../lib/storage/s3-client"

function fakeStorage(overrides: Partial<StorageProvider> = {}) {
  const putObject = mock(async () => {})
  const getObjectStream = mock(async () => Readable.from(["bytes"]))
  const storage = {
    putObject,
    getObjectStream,
    delete: mock(async () => {}),
    getObject: mock(async () => Buffer.from("")),
    getObjectSize: mock(async () => 0),
    getObjectStat: mock(async () => ({ sizeBytes: 0, etag: "e" })),
    getObjectRange: mock(async () => Buffer.from("")),
    getObjectContent: mock(async () => ({}) as never),
    ...overrides,
  } as unknown as StorageProvider
  return { storage, putObject, getObjectStream }
}

describe("AvatarService persona variants", () => {
  it("uploadRawForPersona writes the persona-namespaced raw key", async () => {
    const { storage, putObject } = fakeStorage()
    const service = new AvatarService(storage)

    const key = await service.uploadRawForPersona({
      buffer: Buffer.from("img"),
      workspaceId: "workspace_1",
      personaId: "persona_custom_1",
    })

    expect(key).toMatch(/^avatars\/workspace_1\/personas\/persona_custom_1\/\d+\.original$/)
    expect(putObject).toHaveBeenCalledWith(key, expect.any(Buffer), "application/octet-stream")
    // The processed base path derives from the raw key by dropping `.original`.
    expect(service.rawKeyToBasePath(key)).toBe(key.replace(/\.original$/, ""))
  })

  it("streamPersonaAvatarFile serves a valid processed variant from the persona namespace", async () => {
    const { storage, getObjectStream } = fakeStorage()
    const service = new AvatarService(storage)

    const stream = await service.streamPersonaAvatarFile({
      workspaceId: "workspace_1",
      personaId: "persona_custom_1",
      file: "1720000000000.256.webp",
    })

    expect(stream).not.toBeNull()
    expect(getObjectStream).toHaveBeenCalledWith("avatars/workspace_1/personas/persona_custom_1/1720000000000.256.webp")
  })

  it("streamPersonaAvatarFile rejects a filename outside the read pattern (no S3 read)", async () => {
    const { storage, getObjectStream } = fakeStorage()
    const service = new AvatarService(storage)

    for (const bad of ["../../etc/passwd", "1720000000000.512.webp", "foo.256.webp", "1720000000000.256.png"]) {
      expect(
        await service.streamPersonaAvatarFile({ workspaceId: "workspace_1", personaId: "persona_custom_1", file: bad })
      ).toBeNull()
    }
    expect(getObjectStream).not.toHaveBeenCalled()
  })

  it("uploadImages rejects a base path that would produce an unservable filename", async () => {
    const { storage } = fakeStorage()
    const service = new AvatarService(storage)
    // A base path whose final segment isn't the numeric timestamp the read
    // pattern expects must be caught before it writes an unreadable object.
    await expect(
      service.uploadImages("avatars/workspace_1/personas/p/notatimestamp", new Map([[256, Buffer.from("x")]]))
    ).rejects.toThrow(/doesn't match read pattern/)
  })
})
