import type { PerformanceCapture } from "@threa/types"
import { api } from "./client"

/**
 * Uploads one capture. User-triggered only — no `sendBeacon`, no unload hook:
 * an upload the user did not ask for is not consent, and a beacon hides the
 * server's answer (including a 403 when consent was revoked elsewhere).
 */
export async function sendPerfCapture(workspaceId: string, capture: PerformanceCapture): Promise<{ id: string }> {
  return api.post<{ id: string }>(`/api/workspaces/${workspaceId}/perf-captures`, capture)
}
