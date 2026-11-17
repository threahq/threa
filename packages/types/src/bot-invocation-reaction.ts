import { z } from "zod"

export const botInvocationReactionMetadataSchema = z.object({
  reaction: z.object({
    events: z.array(
      z.object({
        action: z.enum(["added", "removed"]),
        emoji: z.string().min(1),
        reactorId: z.string().min(1),
        reactorName: z.string().nullable(),
      })
    ),
  }),
})

export type BotInvocationReactionMetadata = z.infer<typeof botInvocationReactionMetadataSchema>
export type BotInvocationReactionEvent = BotInvocationReactionMetadata["reaction"]["events"][number]
