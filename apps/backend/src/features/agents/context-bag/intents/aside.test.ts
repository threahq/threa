import { describe, expect, test } from "bun:test"
import { ContextIntents, ContextRefKinds } from "@threa/types"
import { AsideIntent } from "./aside"
import { getIntentConfig } from "../registry"

describe("AsideIntent config", () => {
  test("is registered under the aside intent with the viewport + conversation kinds", () => {
    expect(getIntentConfig(ContextIntents.ASIDE)).toBe(AsideIntent)
    expect(AsideIntent.intent).toBe(ContextIntents.ASIDE)
    expect(AsideIntent.supportedKinds).toEqual([ContextRefKinds.VIEWPORT, ContextRefKinds.CONVERSATION])
  })

  test("keeps summarisation dormant — the viewport resolver bounds the window before render", () => {
    expect(AsideIntent.inlineCharThreshold).toBe(Number.POSITIVE_INFINITY)
  })

  test("preamble explains the on-screen section, the access boundary, and the delta precedence", () => {
    const preamble = AsideIntent.systemPreamble
    expect(preamble).toContain("On screen when the aside was opened")
    expect(preamble).toContain("run on the user's access")
    expect(preamble).toContain("Since last turn")
    expect(preamble.toLowerCase()).toContain("authoritative")
    expect(preamble.toLowerCase()).toContain("do not paste raw")
    expect(preamble).toContain("viewport:<stream_id>")
  })
})
