import type { Pool } from "pg"
import { logger } from "@threa/backend-common"
import type { Job, JobHandler } from "../../lib/queue"
import type { GithubWebhookProcessJobData } from "../../lib/queue/job-queue"
import { findGithubPreviewMatches, refreshLinkPreview, type LinkPreviewService } from "../link-previews"
import type { WorkspaceIntegrationService } from "../workspace-integrations"
import { GITHUB_INSTALLATION_EVENT_TYPE, GITHUB_REFRESH_EVENT_TYPES } from "./config"
import { deriveGithubTargetUrls } from "./derive"

const log = logger.child({ module: "github-webhook-worker" })

const REFRESH_EVENTS: ReadonlySet<string> = new Set(GITHUB_REFRESH_EVENT_TYPES)
/** Installation actions that revoke this region's access to the install. */
const DEACTIVATING_INSTALLATION_ACTIONS: ReadonlySet<string> = new Set(["deleted", "suspend"])

interface GithubWebhookWorkerDeps {
  pool: Pool
  linkPreviewService: LinkPreviewService
  workspaceIntegrationService: WorkspaceIntegrationService
}

/**
 * Process one verified GitHub webhook delivery: resolve every workspace on the
 * installation, derive the canonical PR/issue URL from the payload, and
 * force-refresh matching link previews (webhook = invalidation signal, not the
 * data source — the refresh re-fetches through the GitHub API). Lifecycle
 * `installation` events deactivate the integration instead. A delivery that
 * matches no workspace or no preview row is a clean no-op.
 */
export function createGithubWebhookWorker(deps: GithubWebhookWorkerDeps): JobHandler<GithubWebhookProcessJobData> {
  return async (job: Job<GithubWebhookProcessJobData>) => {
    const { eventType, action, installationId, repositoryFullName, payload, deliveryGuid } = job.data

    if (!installationId) {
      log.debug({ deliveryGuid, eventType }, "GitHub webhook has no installation id; nothing to resolve")
      return
    }

    if (eventType === GITHUB_INSTALLATION_EVENT_TYPE) {
      await handleInstallationEvent(deps, installationId, action, deliveryGuid)
      return
    }

    if (!REFRESH_EVENTS.has(eventType)) {
      log.debug({ deliveryGuid, eventType }, "GitHub webhook event not a refresh trigger; skipping")
      return
    }

    const workspaceIds = await deps.workspaceIntegrationService.listActiveWorkspaceIdsForInstallation(installationId)
    if (workspaceIds.length === 0) {
      log.debug({ deliveryGuid, installationId }, "No active workspaces for installation; skipping")
      return
    }

    const targetUrls = deriveGithubTargetUrls({ eventType, repositoryFullName, payload })
    if (targetUrls.length === 0) {
      log.debug({ deliveryGuid, eventType }, "No canonical URL derived from webhook payload; skipping")
      return
    }

    for (const workspaceId of workspaceIds) {
      const matches = await findGithubPreviewMatches(deps.pool, workspaceId, targetUrls)
      for (const match of matches) {
        await refreshLinkPreview(
          {
            linkPreviewService: deps.linkPreviewService,
            workspaceIntegrationService: deps.workspaceIntegrationService,
          },
          { workspaceId, previewId: match.id }
        )
      }
    }
  }
}

async function handleInstallationEvent(
  deps: GithubWebhookWorkerDeps,
  installationId: string,
  action: string | null,
  deliveryGuid: string
): Promise<void> {
  if (action && DEACTIVATING_INSTALLATION_ACTIONS.has(action)) {
    const { deactivatedWorkspaceIds } = await deps.workspaceIntegrationService.deactivateInstallation(installationId)
    log.info(
      { deliveryGuid, installationId, action, deactivatedWorkspaceIds },
      "Deactivated GitHub integrations for removed/suspended installation"
    )
    return
  }

  log.debug({ deliveryGuid, installationId, action }, "Installation event with no deactivating action; no-op")
}
