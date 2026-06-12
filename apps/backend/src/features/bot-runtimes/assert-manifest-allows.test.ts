import { describe, expect, it } from "bun:test"
import { HttpError } from "@threa/backend-common"
import { assertManifestAllows } from "./assert-manifest-allows"

describe("assertManifestAllows", () => {
  it("leaves a legacy null manifest unenforced", () => {
    expect(() => assertManifestAllows(null, "sources")).not.toThrow()
  })

  it("passes when the declared manifest allows the output", () => {
    const manifest = { output: { reply: true, trace: true, sources: true } }
    expect(() => assertManifestAllows(manifest, "sources")).not.toThrow()
  })

  it("rejects loudly when the declared manifest omits the output", () => {
    const manifest = { output: { reply: true, trace: true, sources: false } }
    let caught: unknown
    try {
      assertManifestAllows(manifest, "sources")
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(HttpError)
    expect(caught).toMatchObject({ status: 400, code: "CAPABILITY_NOT_DECLARED" })
  })
})
