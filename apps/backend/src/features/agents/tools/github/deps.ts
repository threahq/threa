import type { GitHubClient } from "../../../workspace-integrations"

export interface GitHubToolDeps {
  workspaceId: string
  /**
   * Resolve the workspace's GitHub client for a repository owner. Passing the owner
   * lets the service prefer the installation that owns that account (no quota
   * borrowing across installs); callers should memoize per owner so a single agent
   * turn doesn't re-fetch the integration record (and possibly refresh the token)
   * on every tool invocation.
   */
  getClient: (owner?: string) => Promise<GitHubClient | null>
}
