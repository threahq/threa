import { describe, expect, test } from "bun:test"
import {
  CALL_TRANSPORT_CAPABILITIES,
  callTransportTransferSchema,
  callTransferReadyAckSchema,
  p2pPublicationSchema,
  requestCallTransportTransferSchema,
} from "./calls"

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

describe("call transfer contracts", () => {
  test("should preserve p2p-v1 and accept an independent transfer request", () => {
    expect({
      transportCapabilities: CALL_TRANSPORT_CAPABILITIES,
      request: requestCallTransportTransferSchema.safeParse({ target: "p2p", idempotencyKey: "request_1" }).success,
    }).toEqual({ transportCapabilities: ["p2p-v1"], request: true })
  })

  test("should reject acknowledgements without exact generation identity", () => {
    expect(
      callTransferReadyAckSchema.safeParse({
        transferId: "callxfer_1",
        endpointId: "callep_1",
        endpointEpoch: 1,
        mediaIncarnation: "inc_1",
        membershipRevision: 2,
        trackRevision: 3,
        ownPublicationsReady: true,
        readyPublications: [],
      }).success
    ).toBe(false)
  })

  test("should reject malformed transfer phases", () => {
    expect(
      callTransportTransferSchema.safeParse({
        id: "callxfer_1",
        version: 1,
        source: { generation: 1, transport: "sfu" },
        target: { generation: 2, transport: "p2p" },
        membershipRevision: 1,
        phase: "switching",
        cause: "explicit",
        failureCode: null,
        recoveryCode: null,
        sessions: [],
        obligations: [],
      }).success
    ).toBe(false)
  })
})
