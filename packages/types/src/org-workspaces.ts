import { z } from "zod"
import { WORKSPACE_TIER_VALUES } from "./constants"

const orgWorkspacePersonSchema = z
  .object({
    name: z.string().min(1),
    email: z
      .email()
      .transform((email) => email.toLowerCase())
      .nullable(),
    externalIdentity: z
      .object({
        provider: z.string().min(1),
        externalTeamId: z.string().min(1),
        externalUserId: z.string().min(1),
      })
      .strict()
      .nullable(),
  })
  .strict()
  .refine((person) => person.email !== null || person.externalIdentity !== null, {
    message: "A person needs an email or an external identity",
  })

/**
 * Control plane → region: the unclaimed workspace for a counterpart org, plus the people it should hold.
 * Strict, so a change that adds a field deploys the regions first.
 */
export const orgWorkspaceEnsureSchema = z
  .object({
    workspaceId: z.string().min(1),
    name: z.string().min(1),
    slug: z.string().min(1),
    tier: z.enum(WORKSPACE_TIER_VALUES),
    people: z.array(orgWorkspacePersonSchema),
  })
  .strict()
export type OrgWorkspaceEnsureRequest = z.infer<typeof orgWorkspaceEnsureSchema>
/** Someone from a counterpart org, known by an email, an external identity, or both. */
export type OrgWorkspacePerson = OrgWorkspaceEnsureRequest["people"][number]
