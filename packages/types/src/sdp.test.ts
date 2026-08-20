import { describe, expect, it } from "bun:test"
import { summarizeSdpMSections } from "./sdp"

describe("summarizeSdpMSections", () => {
  it("should list mid, kind, and direction per m-section in SDP order", () => {
    const sdp = [
      "v=0",
      "m=audio 9 UDP/TLS/RTP/SAVPF 111",
      "a=mid:0",
      "a=sendonly",
      "m=video 9 UDP/TLS/RTP/SAVPF 96",
      "a=mid:2",
      "a=recvonly",
      "m=video 9 UDP/TLS/RTP/SAVPF 96",
      "a=mid:3",
      "a=sendonly",
    ].join("\r\n")
    expect(summarizeSdpMSections(sdp)).toBe("0:audio:sendonly 2:video:recvonly 3:video:sendonly")
    expect(summarizeSdpMSections(undefined)).toBe("none")
    expect(summarizeSdpMSections("v=0")).toBe("none")
  })
})
