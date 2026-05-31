import { describe, test, expect } from "bun:test"
import { AGENT_TOOL_NAMES } from "./constants"
import {
  TOOL_CATEGORIES_BY_NAME,
  TOOL_PRIVACY_CATEGORIES,
  type ToolPrivacyCategory,
  isToolAllowedByPolicy,
  isToolCategoryAllowed,
} from "./tool-privacy"

/** Widen the `as const` tuple so `.toContain` on an arbitrary category typechecks. */
function categoriesOf(name: keyof typeof TOOL_CATEGORIES_BY_NAME): readonly ToolPrivacyCategory[] {
  return TOOL_CATEGORIES_BY_NAME[name]
}

describe("TOOL_CATEGORIES_BY_NAME", () => {
  test("maps every agent tool to a non-empty set of valid categories", () => {
    for (const name of AGENT_TOOL_NAMES) {
      const categories = categoriesOf(name)
      expect(categories.length).toBeGreaterThan(0)
      for (const category of categories) expect(TOOL_PRIVACY_CATEGORIES).toContain(category)
    }
  })

  test("send_message is the only messaging tool, and messaging never mixes with other categories", () => {
    const messaging = AGENT_TOOL_NAMES.filter((n) => categoriesOf(n).includes("messaging"))
    expect(messaging).toEqual(["send_message"])
    expect(categoriesOf("send_message")).toEqual(["messaging"])
  })

  test("GitHub reads ride the web grant; Linear stays auth-locked", () => {
    const github = AGENT_TOOL_NAMES.filter((n) => categoriesOf(n).includes("github"))
    expect(github.length).toBeGreaterThan(0)
    for (const name of github) expect(categoriesOf(name)).toContain("web")

    const linear = AGENT_TOOL_NAMES.filter((n) => categoriesOf(n).includes("linear"))
    expect(linear.length).toBeGreaterThan(0)
    for (const name of linear) expect(categoriesOf(name)).not.toContain("web")
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

  test("a web policy reaches GitHub reads (shared category) but not raw github/linear/workspace", () => {
    expect(isToolAllowedByPolicy(["web"], "read_url")).toBe(true)
    expect(isToolAllowedByPolicy(["web"], "github_get_issue")).toBe(true) // github read rides web
    expect(isToolAllowedByPolicy(["web"], "linear_get_issue")).toBe(false) // linear is auth-locked
    expect(isToolAllowedByPolicy(["web"], "search_messages")).toBe(false) // workspace is private
  })

  test("a github-only policy does NOT grant raw web (the asymmetry)", () => {
    expect(isToolAllowedByPolicy(["github"], "github_get_issue")).toBe(true)
    expect(isToolAllowedByPolicy(["github"], "web_search")).toBe(false)
    expect(isToolAllowedByPolicy(["github"], "read_url")).toBe(false)
  })
})
