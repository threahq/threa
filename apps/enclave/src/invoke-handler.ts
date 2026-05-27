import type { Request, Response, NextFunction } from "express"
import { timingSafeEqual } from "node:crypto"
import { z } from "zod"
import type { Orchestrator, InvokeRequest } from "./orchestrator"

const envelopeRecipientSchema = z.object({
  recipientKeyId: z.string(),
  enc: z.string(),
  ct: z.string(),
})

const envelopeSchema = z.object({
  v: z.number(),
  ciphertext: z.string(),
  iv: z.string(),
  aad: z.string(),
  recipients: z.array(envelopeRecipientSchema),
})

const historyEntrySchema = z.object({
  id: z.string(),
  authorId: z.string(),
  authorType: z.enum(["user", "persona", "bot"]),
  createdAt: z.string(),
  ciphertext: z.string(),
  envelope: envelopeSchema,
  e2eVersion: z.number(),
  sequence: z.string(),
})

const personaSchema = z.object({
  id: z.string(),
  name: z.string(),
  systemPrompt: z.string(),
  model: z.string(),
  temperature: z.number().nullable(),
  maxTokens: z.number().nullable(),
  e2eEnabledTools: z.array(z.string()),
  currentTime: z.string(),
  timezone: z.string(),
})

const invokeBodySchema = z.object({
  invocationId: z.string(),
  sessionId: z.string(),
  streamId: z.string(),
  replyMessageId: z.string(),
  persona: personaSchema,
  history: z.array(historyEntrySchema),
  recipients: z.array(z.object({ recipientKeyId: z.string(), publicKey: z.string() })),
  aadParts: z.object({ streamId: z.string(), senderId: z.string() }),
})

export function createBearerAuth(secret: string) {
  const expected = Buffer.from(`Bearer ${secret}`)
  return (req: Request, res: Response, next: NextFunction) => {
    const header = Buffer.from(req.headers.authorization ?? "")
    if (header.length !== expected.length || !timingSafeEqual(header, expected)) {
      res.status(401).json({ error: "Unauthorized" })
      return
    }
    next()
  }
}

export function createInvokeHandler(orchestrator: Orchestrator) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const parsed = invokeBodySchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request body", details: parsed.error.issues })
      return
    }
    try {
      const result = await orchestrator.invoke(parsed.data as InvokeRequest)
      res.json(result)
    } catch (err) {
      next(err)
    }
  }
}
