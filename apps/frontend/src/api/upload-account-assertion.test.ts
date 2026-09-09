import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ACCOUNT_ASSERTION_HEADER, AuthErrorCodes } from "@threahq/types"
import { setAssertedAccount, subscribeAccountMismatch } from "./account-assertion"
import { attachmentsApi } from "./attachments"
import { isAccountMismatchError, isPermanentApiError, type ApiError } from "./client"
import { workspacesApi } from "./workspaces"

function mockResponse(status: number, body: unknown): Response {
  // `requestMultipart` reads the response's railway correlation header, so the
  // stub needs a real Headers.
  return { ok: status >= 200 && status < 300, status, headers: new Headers(), json: async () => body } as unknown as Response
}

function headerOf(call: number): Record<string, string> {
  const init = vi.mocked(globalThis.fetch).mock.calls[call][1] as RequestInit
  return (init.headers ?? {}) as Record<string, string>
}

/**
 * The two credentialed multipart uploads used to post raw, so an attachment or
 * avatar transfer formed under one account and sent after a switch executed as
 * whoever the cookie named by then.
 */
describe("credentialed uploads state their account", () => {
  const originalFetch = globalThis.fetch
  const file = () => new File(["bytes"], "shot.png", { type: "image/png" })

  beforeEach(() => {
    globalThis.fetch = vi.fn() as unknown as typeof fetch
    setAssertedAccount("workos_a")
  })

  afterEach(() => {
    setAssertedAccount(null)
    globalThis.fetch = originalFetch
  })

  it("asserts the account on an attachment upload", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(mockResponse(200, { attachment: { id: "attach_1" } }))

    await expect(attachmentsApi.upload("ws_1", file())).resolves.toEqual({ id: "attach_1" })

    expect(headerOf(0)[ACCOUNT_ASSERTION_HEADER]).toBe("workos_a")
  })

  it("keeps the e2e flag on the form it sends", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(mockResponse(200, { attachment: { id: "attach_1" } }))

    await attachmentsApi.upload("ws_1", file(), { e2e: true })

    const init = vi.mocked(globalThis.fetch).mock.calls[0][1] as RequestInit
    const form = init.body as FormData
    expect({ e2e: form.get("e2e"), named: (form.get("file") as File).name }).toEqual({
      e2e: "true",
      named: "shot.png",
    })
  })

  it("asserts the account on a profile avatar upload", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(mockResponse(200, { user: { id: "usr_1" } }))

    await expect(workspacesApi.uploadAvatar("ws_1", file())).resolves.toEqual({ id: "usr_1" })

    expect(headerOf(0)[ACCOUNT_ASSERTION_HEADER]).toBe("workos_a")
  })

  it("pauses a refused upload for its own account instead of discarding it", async () => {
    const refusal = {
      error: "This browser is signed in as a different account",
      code: AuthErrorCodes.ACCOUNT_MISMATCH,
    }
    vi.mocked(globalThis.fetch)
      .mockResolvedValueOnce(mockResponse(409, refusal))
      .mockResolvedValueOnce(mockResponse(409, refusal))

    let reported = 0
    const unsubscribe = subscribeAccountMismatch(() => {
      reported += 1
    })

    const attachmentError = (await attachmentsApi.upload("ws_1", file()).catch((e) => e)) as ApiError
    const avatarError = (await workspacesApi.uploadAvatar("ws_1", file()).catch((e) => e)) as ApiError
    unsubscribe()

    expect({
      attachmentMismatch: isAccountMismatchError(attachmentError),
      avatarMismatch: isAccountMismatchError(avatarError),
      // A moved account is not a verdict on the bytes: the upload manager must
      // not reconcile the transfer away as a permanent rejection.
      attachmentPermanent: isPermanentApiError(attachmentError),
      avatarPermanent: isPermanentApiError(avatarError),
      reported,
    }).toEqual({
      attachmentMismatch: true,
      avatarMismatch: true,
      attachmentPermanent: false,
      avatarPermanent: false,
      reported: 2,
    })
  })
})
