import { z } from "zod"

export const WORKSPACE_NAME_MAX_LENGTH = 100

/** The name rule for creating and renaming a workspace, on every side that accepts one. */
export const workspaceNameSchema = z.string().trim().min(1).max(WORKSPACE_NAME_MAX_LENGTH)

export const updateWorkspaceSchema = z.object({ name: workspaceNameSchema }).strict()

/** Socket payload of `workspace:name_updated`. */
export interface WorkspaceNameUpdatedPayload {
  workspaceId: string
  name: string
}
