import { logger } from "@threahq/backend-common"
import type { ControlPlaneWorkspaceService } from "../workspaces"

/** Never fails the sign-in: every later sign-in retries the WorkOS sync. */
export async function claimOrgWorkspacesOnSignIn(
  workspaceService: ControlPlaneWorkspaceService,
  user: { id: string; email: string; emailVerified: boolean; name: string }
): Promise<void> {
  try {
    await workspaceService.claimOrgWorkspaces({
      workosUserId: user.id,
      email: user.email,
      emailVerified: user.emailVerified,
      name: user.name,
    })
  } catch (error) {
    logger.error({ err: error }, "Org workspace claim failed on sign-in")
  }
}
