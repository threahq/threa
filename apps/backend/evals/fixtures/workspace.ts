/**
 * Workspace fixtures for evaluations.
 *
 * Creates a workspace with a test user for evaluation cases.
 */

import type { Pool } from "pg"
import { withTransaction } from "../../src/db"
import { WorkspaceRepository, UserRepository } from "../../src/features/workspaces"
import { workspaceId, userId } from "../../src/lib/id"

/**
 * Workspace fixture data created for evals.
 */
export interface WorkspaceFixture {
  workspaceId: string
  workspaceName: string
  workspaceSlug: string
  userId: string // Internal usr_xxx ULID
  userName: string
  userEmail: string
}

/**
 * Create a workspace fixture for evaluations.
 *
 * Creates:
 * - A test user
 * - A test workspace
 * - The user as owner of the workspace
 */
export async function createWorkspaceFixture(pool: Pool): Promise<WorkspaceFixture> {
  const wsId = workspaceId()
  const timestamp = Date.now()
  const workosUserId = `workos_eval_${timestamp}`
  const ownerUserId = userId()
  const userName = `Eval User ${timestamp}`
  const userEmail = `eval-user-${timestamp}@test.local`

  const fixture = await withTransaction(pool, async (client) => {
    // Create workspace
    const workspace = await WorkspaceRepository.insert(client, {
      id: wsId,
      name: `Eval Workspace ${timestamp}`,
      slug: `eval-workspace-${timestamp}`,
      createdBy: ownerUserId,
    })

    // Add owner user
    await UserRepository.insert(client, {
      id: ownerUserId,
      workspaceId: workspace.id,
      workosUserId,
      email: userEmail,
      slug: `eval-user-${timestamp}`,
      name: userName,
      role: "owner",
    })

    return {
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      workspaceSlug: workspace.slug,
      userId: ownerUserId,
      userName,
      userEmail,
    }
  })

  return fixture
}

/** The fixture a kept eval database was seeded with: its one workspace and that workspace's owner. */
export async function loadWorkspaceFixture(pool: Pool): Promise<WorkspaceFixture> {
  const { rows } = await pool.query<{
    workspace_id: string
    workspace_name: string
    workspace_slug: string
    user_id: string
    user_name: string
    user_email: string
  }>(
    `SELECT w.id AS workspace_id, w.name AS workspace_name, w.slug AS workspace_slug,
            u.id AS user_id, u.name AS user_name, u.email AS user_email
     FROM workspaces w
     JOIN users u ON u.workspace_id = w.id AND u.role = 'owner'`
  )
  if (rows.length !== 1) {
    throw new Error(`Expected one workspace with one owner in the kept database, found ${rows.length}`)
  }
  const row = rows[0]!
  return {
    workspaceId: row.workspace_id,
    workspaceName: row.workspace_name,
    workspaceSlug: row.workspace_slug,
    userId: row.user_id,
    userName: row.user_name,
    userEmail: row.user_email,
  }
}

/**
 * Create additional users in a workspace.
 * Useful for testing multi-participant scenarios.
 */
export async function createAdditionalUser(
  pool: Pool,
  workspaceId: string,
  options: {
    name?: string
    email?: string
    timezone?: string
  } = {}
): Promise<{ userId: string; userName: string; userEmail: string }> {
  const timestamp = Date.now()
  const workosUserId = `workos_eval_${timestamp}`
  const userName = options.name ?? `Eval User ${timestamp}`
  const userEmail = options.email ?? `eval-user-${timestamp}@test.local`

  const internalUserId = userId()

  const result = await withTransaction(pool, async (client) => {
    // Add to workspace as user
    await UserRepository.insert(client, {
      id: internalUserId,
      workspaceId,
      workosUserId,
      email: userEmail,
      slug: `eval-user-${timestamp}`,
      name: userName,
      role: "member",
      timezone: options.timezone,
    })

    return {
      userId: internalUserId,
      userName,
      userEmail,
    }
  })

  return result
}
