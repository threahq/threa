import { describe, it, expect } from "vitest"
import { createSeekCoalescer, type SeekableMedia } from "./seek-coalescer"

function fakeMedia(opts: { startsSeeks?: boolean; fastSeek?: boolean } = {}) {
  const log: string[] = []
  let time = 0
  const media: SeekableMedia = {
    get currentTime() {
      return time
    },
    set currentTime(t: number) {
      time = t
      log.push(`exact:${t}`)
    },
    seeking: opts.startsSeeks ?? true,
    fastSeek: opts.fastSeek
      ? (t: number) => {
          time = t
          log.push(`fast:${t}`)
        }
      : undefined,
  }
  return { media, log }
}

describe("createSeekCoalescer", () => {
  it("keeps one seek in flight and applies only the newest request when it lands", () => {
    const { media, log } = fakeMedia({ fastSeek: true })
    const seeks = createSeekCoalescer(media)

    seeks.request(1, false)
    seeks.request(2, false)
    seeks.request(3, false)
    expect({ log: [...log], target: seeks.target, inFlight: seeks.inFlight }).toEqual({
      log: ["fast:1"],
      target: 3,
      inFlight: 1,
    })

    seeks.seeked()
    seeks.seeked()
    expect({ log, target: seeks.target }).toEqual({ log: ["fast:1", "fast:3"], target: null })
  })

  it("lands a final exact request on the exact time even right behind a fast seek to it", () => {
    const { media, log } = fakeMedia({ fastSeek: true })
    const seeks = createSeekCoalescer(media)

    seeks.request(5, false)
    seeks.request(5, true)
    seeks.seeked()
    seeks.seeked()
    expect(log).toEqual(["fast:5", "exact:5"])
  })

  it("lets a final exact request win over earlier queued fast ones", () => {
    const { media, log } = fakeMedia({ fastSeek: true })
    const seeks = createSeekCoalescer(media)

    seeks.request(1, false)
    seeks.request(2, false)
    seeks.request(7, true)
    seeks.seeked()
    seeks.seeked()
    expect(log).toEqual(["fast:1", "exact:7"])
  })

  it("sets currentTime for non-exact requests when the element has no fastSeek", () => {
    const { media, log } = fakeMedia()
    createSeekCoalescer(media).request(4, false)
    expect(log).toEqual(["exact:4"])
  })

  it("never waits for a seeked event the element will not fire", () => {
    const { media, log } = fakeMedia({ startsSeeks: false })
    const seeks = createSeekCoalescer(media)
    seeks.request(1, true)
    seeks.request(2, true)
    expect({ log, target: seeks.target }).toEqual({ log: ["exact:1", "exact:2"], target: null })
  })

  it("drops queued work on reset", () => {
    const { media, log } = fakeMedia()
    const seeks = createSeekCoalescer(media)
    seeks.request(1, true)
    seeks.request(2, true)
    seeks.reset()
    seeks.seeked()
    expect({ log, target: seeks.target }).toEqual({ log: ["exact:1"], target: null })
  })
})
