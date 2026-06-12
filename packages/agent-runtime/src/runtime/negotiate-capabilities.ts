import { areToolCategoriesAllowed, type ToolPrivacyCategory } from "@threa/types"
import type { AgentTool } from "./agent-tool"

/**
 * How the host authenticated the actor taking the turn (agent-runtimes
 * unification §2.2.3, Phase 2.4). The tier is host-assigned from the
 * authentication channel — in-process construction, the enclave registration
 * path, or a public-API bot key. It never crosses the wire and never lives on
 * a runner-supplied manifest: a manifest is the runner's claim, and the tier
 * gates key material.
 *
 * `FIRST_PARTY_ATTESTED` is operational, not adversarial, until E2EE-21/22
 * close (Phase 2.4b/c): enclave identity currently rests on internal-key
 * secrecy, not verified attestation.
 */
export const TrustTiers = {
  /** First-party persona constructed in-process (the companion). */
  FIRST_PARTY_INPROC: "first-party-inproc",
  /** First-party runtime authenticated via the enclave registration path. */
  FIRST_PARTY_ATTESTED: "first-party-attested",
  /** Third-party harness authenticated by a workspace bot API key. */
  THIRD_PARTY: "third-party",
} as const

export type TrustTier = (typeof TrustTiers)[keyof typeof TrustTiers]

/**
 * Sealed delivery to third-party actors is a deliberate policy switch, kept
 * inside this gate (§2.6 rule 2) so enabling it is one line plus consent UX —
 * never a redesign. Off until that product decision is made.
 */
export const EXTERNAL_SEALED_DELIVERY = false

export interface SealingContext {
  streamIsE2e: boolean
  /**
   * Whether this actor holds an explicit grant on the stream (an
   * `e2e_stream_actors` row pinned to the actor; the enclave's is automatic
   * at E2E-stream creation, a bot's is the owner's invite). Deliberately the
   * grant, not instance liveness: a momentarily-down runtime must still see a
   * dispatchable turn so the park/revive machinery can hold it, rather than
   * the verdict silently dropping it.
   */
  actorHasGrant: boolean
  /** Pass {@link EXTERNAL_SEALED_DELIVERY}; a parameter so the rule is testable. */
  externalSealedDelivery: boolean
}

export type DeliveryVerdict =
  | { delivery: "plaintext" }
  | { delivery: "sealed" }
  | { delivery: "denied"; reason: "no-key-grant" | "sealed-policy-disabled" }

/**
 * The Phase 2.4 sealed-delivery rule (unification §2.2.3): the single place
 * that answers which payload variant may be minted for an actor on a stream.
 * Dispatch sites compare the verdict against what their driver can carry
 * (companion: plaintext, enclave: sealed, external wire: plaintext) and skip
 * on mismatch — the tier governs what may be minted; the driver governs what
 * it carries. Key possession via grant, not tier alone: "third-party ⇒ never
 * sealed" is deliberately NOT the rule, so an owner-invited, BIK-bearing bot
 * becomes sealed-deliverable by flipping the policy switch, with every
 * downstream path already type-checked.
 *
 * Colocated with `negotiateCapabilities` rather than merged into it: the
 * verdict is consumed at dispatch time (no toolset exists yet), the tool fold
 * at turn-build time. The two entry points share this module as the one
 * chokepoint and converge when turn dispatch itself unifies (redesign §2.2).
 */
export function resolveDeliveryVerdict(params: { trust: TrustTier; sealing: SealingContext }): DeliveryVerdict {
  const { trust, sealing } = params
  if (!sealing.streamIsE2e) return { delivery: "plaintext" }
  // Plaintext is never mintable into an E2E stream, for anyone — INV-E1
  // expressed at dispatch time. Without a grant there is nothing to seal to.
  if (!sealing.actorHasGrant) return { delivery: "denied", reason: "no-key-grant" }
  if (trust === TrustTiers.THIRD_PARTY && !sealing.externalSealedDelivery) {
    return { delivery: "denied", reason: "sealed-policy-disabled" }
  }
  return { delivery: "sealed" }
}

/**
 * The single chokepoint where a stream's tool-privacy policy meets a built
 * toolset (agent-runtimes unification §2.2.3). Phase 1.4 scope: fold the
 * per-stream `allowed_tool_categories` policy over the tools, filtering on each
 * tool's OWN declared `config.categories` — so one function gates the companion
 * (in-process) and the enclave (in-enclave) identically, and the system prompt
 * follows automatically because tool prose derives from the surviving toolset
 * (`buildToolPromptSections`). Later phases grow this into the full
 * `CapabilityManifest` negotiation (trust tiers, sealed-delivery rule).
 */
export interface NegotiateCapabilitiesParams {
  /**
   * Per-stream tool-privacy policy: the allowed categories. `null`/`undefined`
   * means "no restriction" (the default — streams without a policy row).
   * `messaging` and conversation-local tools (empty `categories`) always pass.
   */
  streamPolicy: ToolPrivacyCategory[] | null | undefined
  tools: AgentTool[]
}

export interface NegotiatedCapabilities {
  tools: AgentTool[]
}

export function negotiateCapabilities({ streamPolicy, tools }: NegotiateCapabilitiesParams): NegotiatedCapabilities {
  return {
    tools: tools.filter((tool) => areToolCategoriesAllowed(streamPolicy, tool.config.categories)),
  }
}
