import { z } from "zod"

/** One client's full state is ~200 base64 chars; the cap bounds what one socket fans out per frame. */
export const DOC_AWARENESS_MAX_UPDATE_CHARS = 4096

export const docAwarenessPayloadSchema = z.object({
  workspaceId: z.string().min(1),
  docId: z.string().min(1),
  /** base64 y-protocols awareness update */
  update: z.string().min(1).max(DOC_AWARENESS_MAX_UPDATE_CHARS),
})

export type DocAwarenessPayload = z.infer<typeof docAwarenessPayloadSchema>
