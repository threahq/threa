import { describe, expect, test } from "bun:test"
import { p2pPublicationSchema } from "./calls"

describe("p2pPublicationSchema", () => {
  test("should bound publication revisions to the stored integer range", () => {
    const publications = [{ kind: "mic", publicationId: "pub_one" }]
    expect({
      maximum: p2pPublicationSchema.safeParse({ generation: 1, revision: 2_147_483_647, publications }).success,
      overflow: p2pPublicationSchema.safeParse({ generation: 1, revision: 2_147_483_648, publications }).success,
    }).toEqual({ maximum: true, overflow: false })
  })

  test("should reject duplicate publication kinds", () => {
    const result = p2pPublicationSchema.safeParse({
      generation: 1,
      revision: 1,
      publications: [
        { kind: "mic", publicationId: "pub_one" },
        { kind: "mic", publicationId: "pub_two" },
      ],
    })

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues).toEqual([
        expect.objectContaining({ path: ["publications"], message: "publications must be unique per kind" }),
      ])
    }
  })
})
