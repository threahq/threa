import { AI_SPENDING_COVERAGE, aiSpendingPurpose } from "@threahq/types"
import {
  SpendingDeniedError,
  type SpendingGate,
  type SpendingPolicyMode,
  type SpendingRouteProfile,
} from "@threahq/agent-runtime"
import { policyDenial, type AISpendingService } from "./spend-service"

export interface SpendingGateDeps {
  spendingService: AISpendingService
  /** Approved model + provider envelopes, at most one per OpenRouter model id. */
  routes: readonly SpendingRouteProfile[]
}

/**
 * The runtime's `SpendingGate` over the ledger. Every policy decision is one
 * uncached read; the purpose catalog, not the caller, decides stage and the
 * coverage a route needs.
 */
export function createSpendingGate({ spendingService, routes }: SpendingGateDeps): SpendingGate {
  const routesByModel = new Map<string, SpendingRouteProfile>()
  for (const route of routes) {
    if (routesByModel.has(route.model)) throw new Error(`Duplicate spending route for model ${route.model}`)
    // Copied so a caller editing its profile array later cannot move an approved price or route.
    routesByModel.set(
      route.model,
      Object.freeze({ ...route, supportedParameters: Object.freeze([...route.supportedParameters]) })
    )
  }

  return {
    async policyMode(workspaceId): Promise<SpendingPolicyMode> {
      const policy = await spendingService.getPolicy(workspaceId)
      const denial = policyDenial(policy)
      if (denial) return { mode: "protected", denial }
      return policy?.status === "unprotected" ? { mode: "unprotected" } : { mode: "protected", denial: null }
    },

    async routeFor({ context, modelId }) {
      const purpose = aiSpendingPurpose(context.purpose)
      if (!purpose) return null
      const policy = await spendingService.getPolicy(context.workspaceId)
      if (policy?.status !== "enforced" || policy.coverageProfile !== AI_SPENDING_COVERAGE.profile) return null
      if (!(AI_SPENDING_COVERAGE.metered as readonly string[]).includes(purpose.coverage)) return null
      return routesByModel.get(modelId) ?? null
    },

    async reserve(request) {
      const purpose = aiSpendingPurpose(request.purpose)
      if (purpose?.stage !== request.stage) {
        throw new SpendingDeniedError("MISSING_CONTEXT", {
          reason: "stage does not match purpose",
          purpose: request.purpose,
          stage: request.stage,
        })
      }
      if (purpose.execution === "session" && request.sessionId === null) {
        throw new SpendingDeniedError("MISSING_CONTEXT", {
          reason: "purpose needs a session",
          purpose: request.purpose,
        })
      }
      return spendingService.reserve(request)
    },
    dispatch: (workspaceId, attemptId, executionGeneration) =>
      spendingService.dispatch(workspaceId, attemptId, executionGeneration),
    settle: (params) => spendingService.settle(params),
    release: (workspaceId, attemptId, executionGeneration) =>
      spendingService.release(workspaceId, attemptId, executionGeneration),
    markUnknown: (workspaceId, attemptId, receipt) => spendingService.markUnknown(workspaceId, attemptId, receipt),
  }
}
