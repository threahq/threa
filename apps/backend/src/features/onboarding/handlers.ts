import type { Request, Response } from "express"
import type { OnboardingService } from "./service"

interface Dependencies {
  onboardingService: OnboardingService
}

export function createOnboardingHandlers({ onboardingService }: Dependencies) {
  return {
    async meetAriadne(req: Request, res: Response) {
      const result = await onboardingService.meetAriadne({
        workspaceId: req.workspaceId!,
        userId: req.user!.id,
      })
      res.json(result)
    },
  }
}
