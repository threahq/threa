import { z } from "zod"
import { API_KEY_ELIGIBLE_SCOPES, API_KEY_NAME_MAX_LENGTH } from "@threahq/types"
import { API_VERSIONS, CURRENT_API_VERSION } from "./versions"

/** A key's version pin: a supported version, or null to track the current version. */
const apiKeyVersionPinSchema = z.enum(API_VERSIONS).nullable()

const apiKeyScopesSchema = z.array(z.enum(API_KEY_ELIGIBLE_SCOPES)).min(1, "at least one scope is required")

/** Create body shared by personal and bot keys. */
export const createApiKeySchema = z.object({
  name: z.string().min(1, "name is required").max(API_KEY_NAME_MAX_LENGTH),
  scopes: apiKeyScopesSchema,
  expiresAt: z
    .string()
    .datetime()
    .nullable()
    .optional()
    .refine((val) => val == null || new Date(val) > new Date(), {
      message: "expiresAt must be a future date",
    }),
  apiVersion: apiKeyVersionPinSchema.default(CURRENT_API_VERSION),
})

/** Update body shared by personal and bot keys. */
export const updateApiKeySchema = z
  .object({
    scopes: apiKeyScopesSchema.optional(),
    apiVersion: apiKeyVersionPinSchema.optional(),
  })
  .refine((data) => data.scopes !== undefined || data.apiVersion !== undefined, {
    message: "provide scopes and/or apiVersion",
  })
