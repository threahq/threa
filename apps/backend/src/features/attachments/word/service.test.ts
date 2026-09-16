import { describe, expect, it } from "bun:test"
import { AISpendDeniedError } from "@threahq/agent-runtime"
import { WordProcessingService } from "./service"

describe("WordProcessingService", () => {
  it("should propagate a spend denial instead of storing a failed caption", async () => {
    const denial = new AISpendDeniedError({ workspaceId: "ws_1", functionId: "word-image-caption" }, "workspace_limit")
    const service = new WordProcessingService({
      pool: {} as never,
      storage: {} as never,
      ai: {
        generateObject: async () => {
          throw denial
        },
      } as never,
    })

    const captioning = service["captionEmbeddedImages"](
      [{ data: Buffer.from("png"), mimeType: "image/png", index: 0 }],
      "ws_1",
      "attach_1"
    )

    await expect(captioning).rejects.toBe(denial)
  })
})
