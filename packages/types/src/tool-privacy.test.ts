import { describe, test, expect } from "bun:test"
import { AGENT_TOOL_NAMES } from "./constants"
import {
  TOOL_CATEGORY_BY_NAME,
  TOOL_PRIVACY_CATEGORIES,
  isToolAllowedByPolicy,
  isToolCategoryAllowed,
} from "./tool-privacy"

describe("TOOL_CATEGORY_BY_NAME", () => {
  test("maps every agent tool to a valid category", () => {
    for (const name of AGENT_TOOL_NAMES) {
      const category = TOOL_CATEGORY_BY_NAME[name]
      expect(TOOL_PRIVACY_CATEGORIES).toContain(category)
    }
  })

  test("send_message is the only messaging tool", () => {
    const messaging = AGENT_TOOL_NAMES.filter((n) => TOOL_CATEGORY_BY_NAME[n] === "messaging")
    expect(messaging).toEqual(["send_message"])
  })
})

describe("isToolCategoryAllowed", () => {
  test("null/undefined policy allows every category (default = unrestricted)", () => {
    expect(isToolCategoryAllowed(null, "web")).toBe(true)
    expect(isToolCategoryAllowed(undefined, "workspace")).toBe(true)
  })

  test("messaging is always allowed, even under an empty policy", () => {
    expect(isToolCategoryAllowed([], "messaging")).toBe(true)
    expect(isToolCategoryAllowed(["workspace"], "messaging")).toBe(true)
  })

  test("an explicit policy allows only its listed categories", () => {
    expect(isToolCategoryAllowed(["web"], "web")).toBe(true)
    expect(isToolCategoryAllowed(["web"], "workspace")).toBe(false)
    expect(isToolCategoryAllowed([], "web")).toBe(false)
  })
})

describe("isToolAllowedByPolicy", () => {
  test("send_message survives the strictest policy; web tools do not", () => {
    expect(isToolAllowedByPolicy([], "send_message")).toBe(true)
    expect(isToolAllowedByPolicy([], "web_search")).toBe(false)
    expect(isToolAllowedByPolicy([], "general_research")).toBe(false)
  })

  test("a web-only policy gates workspace and github tools", () => {
    expect(isToolAllowedByPolicy(["web"], "read_url")).toBe(true)
    expect(isToolAllowedByPolicy(["web"], "search_messages")).toBe(false)
    expect(isToolAllowedByPolicy(["web"], "github_get_issue")).toBe(false)
  })
})
