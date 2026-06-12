import { describe, expect, test } from "bun:test"
import { z } from "zod"
import { AgentStepTypes, type ToolPrivacyCategory } from "@threa/types"
import type { AgentTool } from "./agent-tool"
import { defineAgentTool } from "./agent-tool"
import {
  negotiateCapabilities,
  resolveDeliveryVerdict,
  TrustTiers,
  type DeliveryVerdict,
  type SealingContext,
  type TrustTier,
} from "./negotiate-capabilities"

function makeTool(name: string, categories: readonly ToolPrivacyCategory[]): AgentTool {
  return defineAgentTool({
    name,
    description: `${name} description`,
    categories,
    inputSchema: z.object({}),
    execute: async () => ({ output: "ok" }),
    trace: {
      stepType: AgentStepTypes.WEB_SEARCH,
      formatContent: () => "",
    },
  })
}

describe("negotiateCapabilities", () => {
  const webSearch = makeTool("web_search", ["web"])
  const searchMessages = makeTool("search_messages", ["workspace"])
  const githubGetIssue = makeTool("github_get_issue", ["github", "web"])
  const reply = makeTool("send_message", ["messaging"])
  const conversationLocal = makeTool("load_attachment", [])

  test("no policy means no restriction", () => {
    const tools = [webSearch, searchMessages, githubGetIssue]
    expect(negotiateCapabilities({ streamPolicy: null, tools }).tools).toEqual(tools)
    expect(negotiateCapabilities({ streamPolicy: undefined, tools }).tools).toEqual(tools)
  })

  test("filters on any-intersection of each tool's own categories", () => {
    const { tools } = negotiateCapabilities({
      streamPolicy: ["web"],
      tools: [webSearch, searchMessages, githubGetIssue],
    })
    // github_get_issue rides the `web` grant (public-web-class egress);
    // workspace reads drop.
    expect(tools).toEqual([webSearch, githubGetIssue])
  })

  test("an empty policy still passes messaging and conversation-local tools", () => {
    const { tools } = negotiateCapabilities({
      streamPolicy: [],
      tools: [webSearch, reply, conversationLocal, searchMessages],
    })
    expect(tools).toEqual([reply, conversationLocal])
  })
})

describe("resolveDeliveryVerdict", () => {
  const sealing = (overrides: Partial<SealingContext>): SealingContext => ({
    streamIsE2e: false,
    actorHasGrant: false,
    externalSealedDelivery: false,
    ...overrides,
  })
  const allTiers: TrustTier[] = [TrustTiers.FIRST_PARTY_INPROC, TrustTiers.FIRST_PARTY_ATTESTED, TrustTiers.THIRD_PARTY]

  test("a plaintext stream is plaintext for every tier — grant and policy are irrelevant", () => {
    for (const trust of allTiers) {
      for (const actorHasGrant of [false, true]) {
        for (const externalSealedDelivery of [false, true]) {
          expect(
            resolveDeliveryVerdict({ trust, sealing: sealing({ actorHasGrant, externalSealedDelivery }) })
          ).toEqual({ delivery: "plaintext" })
        }
      }
    }
  })

  test("an E2E stream without a grant is denied for every tier — plaintext is never mintable into E2E", () => {
    for (const trust of allTiers) {
      for (const externalSealedDelivery of [false, true]) {
        expect(
          resolveDeliveryVerdict({
            trust,
            sealing: sealing({ streamIsE2e: true, externalSealedDelivery }),
          })
        ).toEqual({ delivery: "denied", reason: "no-key-grant" })
      }
    }
  })

  test("an E2E stream with a grant seals for first-party tiers", () => {
    for (const trust of [TrustTiers.FIRST_PARTY_INPROC, TrustTiers.FIRST_PARTY_ATTESTED]) {
      const verdict: DeliveryVerdict = resolveDeliveryVerdict({
        trust,
        sealing: sealing({ streamIsE2e: true, actorHasGrant: true }),
      })
      expect(verdict).toEqual({ delivery: "sealed" })
    }
  })

  test("third-party with a grant is denied while the policy switch is off — the one-line-flip pin", () => {
    expect(
      resolveDeliveryVerdict({
        trust: TrustTiers.THIRD_PARTY,
        sealing: sealing({ streamIsE2e: true, actorHasGrant: true }),
      })
    ).toEqual({ delivery: "denied", reason: "sealed-policy-disabled" })
    expect(
      resolveDeliveryVerdict({
        trust: TrustTiers.THIRD_PARTY,
        sealing: sealing({ streamIsE2e: true, actorHasGrant: true, externalSealedDelivery: true }),
      })
    ).toEqual({ delivery: "sealed" })
  })
})
