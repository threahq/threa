import type { Pool } from "pg"
import { logger } from "@threahq/backend-common"
import type { Job, JobHandler, QueueManager } from "../../lib/queue"
import type { GithubWebhookProcessJobData } from "../../lib/queue/job-queue"
import { findGithubPreviewMatches, type LinkPreviewService } from "../link-previews"
import type { WorkspaceIntegrationService } from "../workspace-integrations"
import {
  GITHUB_INSTALLATION_EVENT_TYPE,
  GITHUB_INSTALLATION_REPOSITORIES_EVENT_TYPE,
  GITHUB_REFRESH_EVENT_TYPES,
} from "./config"
import { deriveGithubTargetUrls } from "./derive"
import { refreshGithubPreviewWithTrailing } from "./preview-refresh"

const log = logger.child({ module: "github-webhook-worker" })

const REFRESH_EVENTS: ReadonlySet<string> = new Set(GITHUB_REFRESH_EVENT_TYPES)

interface GithubWebhookWorkerDeps {
  pool: Pool
  linkPreviewService: LinkPreviewService
  workspaceIntegrationService: WorkspaceIntegrationService
  jobQueue: Pick<QueueManager, "send">
}

/**
 * Process one verified GitHub webhook delivery: resolve every workspace on the
 * installation, derive the canonical PR/issue URL from the payload, and
 * force-refresh matching link previews (webhook = invalidation signal, not the
 * data source — the refresh re-fetches through the GitHub API). Lifecycle
 * `installation` events deactivate the integration instead, and
 * `installation_repositories` re-syncs the cached repository grant. A delivery
 * that matches no workspace or no preview row is a clean no-op.
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

    if (eventType === GITHUB_INSTALLATION_REPOSITORIES_EVENT_TYPE) {
      const { refreshedWorkspaceIds } =
        await deps.workspaceIntegrationService.refreshGithubInstallationRepositories(installationId)
      log.info(
        { deliveryGuid, installationId, action, refreshedWorkspaceIds },
        "Reconciled GitHub repository grant change"
      )
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
        await refreshGithubPreviewWithTrailing(
          {
            linkPreviewService: deps.linkPreviewService,
            workspaceIntegrationService: deps.workspaceIntegrationService,
            jobQueue: deps.jobQueue,
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
  if (action === "deleted") {
    const { deactivatedWorkspaceIds } = await deps.workspaceIntegrationService.deactivateInstallation(installationId)
    log.info(
      { deliveryGuid, installationId, action, deactivatedWorkspaceIds },
      "Deactivated GitHub integrations for deleted installation"
    )
    return
  }

  // 'suspend'/'unsuspend' are deliberate no-ops. `deactivateInstallation` deletes
  // this region's CP routes, so treating 'suspend' like 'deleted' would strand the
  // install permanently — a later 'unsuspend' could never route back to this
  // region. GitHub already pauses deliveries and API access while an install is
  // suspended (token mint fails → the refresh path skips gracefully), so keeping
  // the routes lets 'unsuspend' recover automatically with zero action here.
  log.debug({ deliveryGuid, installationId, action }, "Installation lifecycle event with no deactivating action; no-op")
}
