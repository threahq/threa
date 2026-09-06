import type { Request, Response } from "express"
import { HttpError } from "@threahq/backend-common"
import type { GithubWebhookService } from "./service"

interface Dependencies {
  service: GithubWebhookService
}

export function createGithubWebhookHandlers({ service }: Dependencies) {
  return {
    async receive(req: Request, res: Response) {
      const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0)
      const result = await service.receive({
        rawBody,
        signature: req.header("X-Hub-Signature-256"),
        eventType: req.header("X-GitHub-Event"),
        deliveryGuid: req.header("X-GitHub-Delivery"),
      })

      switch (result.kind) {
        case "unauthorized":
          throw new HttpError("Invalid signature", { status: 401, code: "INVALID_SIGNATURE" })
        case "invalid_payload":
          throw new HttpError("Invalid webhook payload", { status: 400, code: "INVALID_PAYLOAD" })
        case "pong":
          res.status(200).json({ ok: true })
          return
        case "ignored":
        case "duplicate":
        case "accepted":
          res.status(202).json({ status: result.kind })
          return
      }
    },
  }
}
