import { expect, test } from "@playwright/test"

test("two browser peers exchange real audio and video through RTCPeerConnection", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const left = new RTCPeerConnection()
    const right = new RTCPeerConnection()
    left.onicecandidate = (event) => event.candidate && void right.addIceCandidate(event.candidate)
    right.onicecandidate = (event) => event.candidate && void left.addIceCandidate(event.candidate)

    const audio = new AudioContext()
    const oscillator = audio.createOscillator()
    const audioDestination = audio.createMediaStreamDestination()
    oscillator.connect(audioDestination)
    oscillator.start()

    const canvas = document.createElement("canvas")
    canvas.width = 64
    canvas.height = 64
    const context = canvas.getContext("2d")!
    context.fillStyle = "red"
    context.fillRect(0, 0, 64, 64)
    const videoStream = canvas.captureStream(10)

    const received: string[] = []
    right.ontrack = (event) => received.push(event.track.kind)
    left.addTrack(audioDestination.stream.getAudioTracks()[0])
    const videoSender = left.addTrack(videoStream.getVideoTracks()[0])

    async function negotiate() {
      await left.setLocalDescription(await left.createOffer())
      await right.setRemoteDescription(left.localDescription)
      await right.setLocalDescription(await right.createAnswer())
      await left.setRemoteDescription(right.localDescription)
    }
    await negotiate()
    const deadline = Date.now() + 10_000
    let bytesReceived = 0
    while (Date.now() < deadline) {
      const stats = await right.getStats()
      bytesReceived = 0
      stats.forEach((stat) => {
        if (stat.type === "inbound-rtp") bytesReceived += stat.bytesReceived ?? 0
      })
      if (received.includes("audio") && received.includes("video") && bytesReceived > 0) break
      await new Promise((resolve) => setTimeout(resolve, 100))
    }

    const replacementCanvas = document.createElement("canvas")
    replacementCanvas.width = 64
    replacementCanvas.height = 64
    replacementCanvas.getContext("2d")!.fillRect(0, 0, 64, 64)
    const replacement = replacementCanvas.captureStream(10).getVideoTracks()[0]
    await videoSender.replaceTrack(null)
    await videoSender.replaceTrack(replacement)

    const stateBeforeClose = left.connectionState
    left.close()
    right.close()
    oscillator.stop()
    await audio.close()
    videoStream.getTracks().forEach((track) => track.stop())
    replacement.stop()
    return {
      received: [...new Set(received)].sort(),
      bytesReceived,
      stateBeforeClose,
      stateAfterClose: left.connectionState,
    }
  })

  expect(result).toEqual({
    received: ["audio", "video"],
    bytesReceived: expect.any(Number),
    stateBeforeClose: "connected",
    stateAfterClose: "closed",
  })
  expect(result.bytesReceived).toBeGreaterThan(0)
})
