import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from "vitest"
import { act, render, screen, within, fireEvent, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MemoryRouter } from "react-router-dom"
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query"
import type { AttachmentSummary, StreamBootstrap } from "@threahq/types"
import { MediaGalleryProvider } from "@/contexts"
import { attachmentContentUrl, attachmentsApi } from "@/api"
import { AttachmentList } from "@/components/timeline/attachment-list"
import { streamKeys } from "@/hooks/use-streams"
import { clearAllDecrypted } from "@/lib/crypto/decrypted-cache"
import { registerWorkspaceSocketHandlers } from "@/sync/workspace-sync"
import { AudioPlayer } from "./audio-player"
import { AudioScope, audioSession } from "./audio-session"
import { loadMediaPreferences, saveMediaPreferences } from "./preferences"

const WS = "ws_1"
const STREAM = "stream_1"
const PEAKS = Array.from({ length: 200 }, (_, i) => (i * 37) % 256)
const WAVEFORM = btoa(String.fromCharCode(...PEAKS))

function audioAttachment(overrides: Partial<AttachmentSummary> = {}): AttachmentSummary {
  return {
    id: "att_voice",
    filename: "voice.m4a",
    mimeType: "audio/mp4",
    sizeBytes: 2048,
    audio: { status: "completed", durationMs: 83_000, waveform: WAVEFORM },
    ...overrides,
  }
}

const paused = new WeakMap<HTMLMediaElement, boolean>()
let playSpy: MockInstance<HTMLMediaElement["play"]>

beforeEach(() => {
  vi.restoreAllMocks()
  localStorage.removeItem("threa:media-player:preferences")
  vi.spyOn(HTMLMediaElement.prototype, "paused", "get").mockImplementation(function (this: HTMLMediaElement) {
    return paused.get(this) ?? true
  })
  playSpy = vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(function (this: HTMLMediaElement) {
    paused.set(this, false)
    this.dispatchEvent(new Event("play"))
    return Promise.resolve()
  })
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(function (this: HTMLMediaElement) {
    if (paused.get(this) === false) {
      paused.set(this, true)
      this.dispatchEvent(new Event("pause"))
    }
  })
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {})
})

afterEach(() => {
  act(() => {
    audioSession.stop()
    audioSession.setPlaybackRate(1)
  })
})

function Providers({ children }: { children: React.ReactNode }) {
  return (
    <MemoryRouter>
      <MediaGalleryProvider>{children}</MediaGalleryProvider>
    </MemoryRouter>
  )
}

function renderCards(attachments: AttachmentSummary[]) {
  return render(
    <AudioScope scope={STREAM}>
      <AttachmentList attachments={attachments} workspaceId={WS} />
    </AudioScope>,
    { wrapper: Providers }
  )
}

function card(filename: string): HTMLElement {
  const el = screen.getByText(filename).closest<HTMLElement>("[data-audio-player]")
  if (!el) throw new Error(`no audio card for ${filename}`)
  return el
}

function trackShape(el: HTMLElement) {
  const root = el.querySelector<HTMLElement>("[data-waveform]")
  return { track: root?.dataset.waveform, bars: el.querySelectorAll("[data-waveform-bar]").length }
}

const playLabel = (filename: string) =>
  within(card(filename))
    .getByRole("button", { name: /^(Play|Pause)$/ })
    .getAttribute("aria-label")

const sessionTrack = () => audioSession.getState().track

describe("AudioPlayer card", () => {
  it("draws the waveform from peaks, two stacked layers of the same bars", () => {
    renderCards([audioAttachment()])
    const el = card("voice.m4a")

    expect({ ...trackShape(el), time: within(el).getByText(/\//).textContent }).toEqual({
      track: "bars",
      bars: 128,
      time: "0:00 / 1:23",
    })
  })

  it("falls back to a plain track without peaks", () => {
    renderCards([audioAttachment({ audio: { status: "skipped" } })])

    expect(trackShape(card("voice.m4a"))).toEqual({ track: "plain", bars: 0 })
  })

  it("keeps play disabled while the file is still processing", () => {
    renderCards([audioAttachment({ audio: { status: "processing" } })])

    expect(within(card("voice.m4a")).getByRole("button", { name: "Play" })).toBeDisabled()
  })

  it("plays the processed variant once processing completed, inside the view's scope", async () => {
    const user = userEvent.setup()
    renderCards([audioAttachment()])

    await user.click(within(card("voice.m4a")).getByRole("button", { name: "Play" }))

    expect(sessionTrack()).toEqual({
      key: "att_voice",
      scope: expect.stringContaining(STREAM),
      src: attachmentContentUrl(WS, "att_voice", { variant: "processed" }),
      title: "voice.m4a",
    })
    expect(within(card("voice.m4a")).getByRole("button", { name: "Pause" })).toBeInTheDocument()
  })

  it("plays the original bytes when processing was skipped, failed, or never ran", async () => {
    const user = userEvent.setup()
    renderCards([
      audioAttachment({ id: "att_skipped", filename: "skipped.mp3", audio: { status: "skipped" } }),
      audioAttachment({ id: "att_failed", filename: "failed.wav", audio: { status: "failed" } }),
      audioAttachment({ id: "att_old", filename: "old.ogg", mimeType: "application/octet-stream", audio: undefined }),
    ])

    const played: Array<string | undefined> = []
    for (const filename of ["skipped.mp3", "failed.wav", "old.ogg"]) {
      await user.click(within(card(filename)).getByRole("button", { name: "Play" }))
      played.push(sessionTrack()?.src)
    }

    expect(played).toEqual([
      attachmentContentUrl(WS, "att_skipped", { variant: "raw" }),
      attachmentContentUrl(WS, "att_failed", { variant: "raw" }),
      attachmentContentUrl(WS, "att_old", { variant: "raw" }),
    ])
  })

  it("stops the first card when a second one starts", async () => {
    const user = userEvent.setup()
    renderCards([
      audioAttachment({ id: "att_a", filename: "a.m4a" }),
      audioAttachment({ id: "att_b", filename: "b.m4a" }),
    ])

    await user.click(within(card("a.m4a")).getByRole("button", { name: "Play" }))
    await user.click(within(card("b.m4a")).getByRole("button", { name: "Play" }))

    expect({ key: sessionTrack()?.key, a: playLabel("a.m4a"), b: playLabel("b.m4a") }).toEqual({
      key: "att_b",
      a: "Play",
      b: "Pause",
    })
  })

  it("pauses when other media on the page starts playing", async () => {
    const user = userEvent.setup()
    renderCards([audioAttachment()])
    await user.click(within(card("voice.m4a")).getByRole("button", { name: "Play" }))

    const video = document.createElement("video")
    document.body.appendChild(video)
    act(() => void video.play())

    expect(within(card("voice.m4a")).getByRole("button", { name: "Play" })).toBeInTheDocument()
    video.remove()
  })

  it("leaves a call's live media alone: starting a track doesn't pause it, and it doesn't pause the track", async () => {
    const user = userEvent.setup()
    renderCards([audioAttachment()])
    const live = document.createElement("audio")
    Object.defineProperty(live, "srcObject", { value: {} })
    const video = document.createElement("video")
    document.body.append(live, video)
    act(() => {
      void live.play()
      void video.play()
    })

    await user.click(within(card("voice.m4a")).getByRole("button", { name: "Play" }))
    const afterStart = { live: live.paused, video: video.paused }
    act(() => void live.dispatchEvent(new Event("play")))

    expect({ afterStart, play: playLabel("voice.m4a") }).toEqual({
      afterStart: { live: false, video: true },
      play: "Pause",
    })
    live.remove()
    video.remove()
  })

  it("plays at full volume whatever mute and volume the video player stored, and keeps the stored speed", async () => {
    const user = userEvent.setup()
    saveMediaPreferences({ playbackRate: 1.5, volume: 0.3, muted: true })
    renderCards([audioAttachment()])

    await user.click(within(card("voice.m4a")).getByRole("button", { name: "Play" }))
    const element = playSpy.mock.contexts[0] as HTMLMediaElement

    expect({ muted: element.muted, volume: element.volume, rate: element.playbackRate }).toEqual({
      muted: false,
      volume: 1,
      rate: 1.5,
    })
  })

  it("drops a source that resolves after another card started or its view closed", async () => {
    const user = userEvent.setup()
    const revoked = vi.fn()
    vi.stubGlobal("URL", Object.assign(URL, { revokeObjectURL: revoked }))
    const slow: Array<(src: string) => void> = []
    const resolveSlow = () => new Promise<string>((resolve) => slow.push(resolve))
    const { unmount } = render(
      <AudioScope scope={STREAM}>
        <AudioPlayer
          trackKey="att_slow"
          filename="slow.m4a"
          sizeBytes={1}
          resolveSrc={resolveSlow}
          onDownload={vi.fn()}
        />
        <AudioPlayer trackKey="att_b" filename="b.m4a" sizeBytes={1} resolveSrc={() => "/b"} onDownload={vi.fn()} />
      </AudioScope>,
      { wrapper: Providers }
    )

    await user.click(within(card("slow.m4a")).getByRole("button", { name: "Play" }))
    await user.click(within(card("b.m4a")).getByRole("button", { name: "Play" }))
    await act(async () => slow[0]("blob:overtaken"))
    const afterOvertaken = sessionTrack()?.key

    await user.click(within(card("slow.m4a")).getByRole("button", { name: "Play" }))
    unmount()
    await act(async () => slow[1]("blob:closed"))

    expect({ afterOvertaken, afterClosed: sessionTrack(), revoked: revoked.mock.calls.flat() }).toEqual({
      afterOvertaken: "att_b",
      afterClosed: null,
      revoked: ["blob:overtaken", "blob:closed"],
    })
    vi.unstubAllGlobals()
  })

  it("ends decrypted audio when the E2EE session locks: a playing track, and a decrypt still in flight", async () => {
    const user = userEvent.setup()
    const revoked = vi.fn()
    vi.stubGlobal("URL", Object.assign(URL, { revokeObjectURL: revoked }))
    const slow: Array<(src: string) => void> = []
    const resolveSlow = () => new Promise<string>((resolve) => slow.push(resolve))
    render(
      <AudioScope scope={STREAM}>
        <AudioPlayer
          trackKey="att_e2e"
          filename="e2e.m4a"
          sizeBytes={1}
          resolveSrc={resolveSlow}
          onDownload={vi.fn()}
        />
        <AudioPlayer trackKey="att_b" filename="b.m4a" sizeBytes={1} resolveSrc={() => "/b"} onDownload={vi.fn()} />
      </AudioScope>,
      { wrapper: Providers }
    )

    await user.click(within(card("e2e.m4a")).getByRole("button", { name: "Play" }))
    await act(async () => slow[0]("blob:playing"))
    const beforeLock = sessionTrack()?.key
    act(() => clearAllDecrypted())
    const afterLock = sessionTrack()

    await user.click(within(card("e2e.m4a")).getByRole("button", { name: "Play" }))
    act(() => clearAllDecrypted())
    await act(async () => slow[1]("blob:late"))
    const afterLateDecrypt = sessionTrack()

    await user.click(within(card("b.m4a")).getByRole("button", { name: "Play" }))
    act(() => clearAllDecrypted())

    expect({
      beforeLock,
      afterLock,
      afterLateDecrypt,
      plainTrackAfterLock: sessionTrack()?.key,
      revoked: revoked.mock.calls.flat(),
    }).toEqual({
      beforeLock: "att_e2e",
      afterLock: null,
      afterLateDecrypt: null,
      plainTrackAfterLock: "att_b",
      revoked: ["blob:playing", "blob:late"],
    })
    vi.unstubAllGlobals()
  })

  it("lets a source that failed to resolve be tried again", async () => {
    const user = userEvent.setup()
    const resolveSrc = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue("/ok")
    render(<AudioPlayer trackKey="att_voice" filename="voice.m4a" sizeBytes={1} resolveSrc={resolveSrc} />, {
      wrapper: Providers,
    })

    await user.click(screen.getByRole("button", { name: "Play" }))
    const failed = (await screen.findByRole("alert")).textContent
    await user.click(screen.getByRole("button", { name: "Play" }))

    expect({ failed, playing: await screen.findByRole("button", { name: "Pause" }), src: sessionTrack()?.src }).toEqual(
      {
        failed: "Can't play this file",
        playing: expect.anything(),
        src: "/ok",
      }
    )
  })

  it("ends with its card when no view scope holds it", async () => {
    const user = userEvent.setup()
    const { unmount } = render(
      <AudioPlayer trackKey="att_voice" filename="voice.m4a" sizeBytes={1} resolveSrc={() => "/x"} />,
      { wrapper: Providers }
    )
    await user.click(screen.getByRole("button", { name: "Play" }))
    const whilePlaying = sessionTrack()?.key

    unmount()

    expect({ whilePlaying, afterUnmount: sessionTrack() }).toEqual({ whilePlaying: "att_voice", afterUnmount: null })
  })

  it("keeps a track playing when another view of the same stream closes", async () => {
    const user = userEvent.setup()
    const other = renderCards([audioAttachment({ id: "att_other", filename: "other.m4a" })])
    renderCards([audioAttachment()])
    await user.click(within(card("voice.m4a")).getByRole("button", { name: "Play" }))

    other.unmount()

    expect({ key: sessionTrack()?.key, play: playLabel("voice.m4a") }).toEqual({ key: "att_voice", play: "Pause" })
  })

  it("keeps playing when the card unmounts, and stops when its view does", async () => {
    const user = userEvent.setup()
    const { rerender, unmount } = renderCards([audioAttachment()])
    await user.click(within(card("voice.m4a")).getByRole("button", { name: "Play" }))
    const element = playSpy.mock.contexts[0] as HTMLMediaElement

    rerender(
      <AudioScope scope={STREAM}>
        <div />
      </AudioScope>
    )
    const afterRowUnmount = { key: sessionTrack()?.key, paused: element.paused }

    unmount()

    expect({ afterRowUnmount, afterViewUnmount: { key: sessionTrack()?.key, paused: element.paused } }).toEqual({
      afterRowUnmount: { key: "att_voice", paused: false },
      afterViewUnmount: { key: undefined, paused: true },
    })
  })

  it("shows the error state in place when the element can't play the file, and download still works", async () => {
    const user = userEvent.setup()
    renderCards([audioAttachment()])
    await user.click(within(card("voice.m4a")).getByRole("button", { name: "Play" }))
    const element = playSpy.mock.contexts[0] as HTMLMediaElement

    act(() => void element.dispatchEvent(new Event("error")))

    const el = card("voice.m4a")
    expect({
      alert: within(el).getByRole("alert").textContent,
      play: within(el).getByRole("button", { name: "Play" }).hasAttribute("disabled"),
      download: within(el).getByRole("button", { name: "Download voice.m4a" }).hasAttribute("disabled"),
    }).toEqual({ alert: "Can't play this file", play: true, download: false })
  })

  it("offers the processed and the original file when a normalized copy exists, and only the upload otherwise", async () => {
    const user = userEvent.setup()
    const getUrl = vi.spyOn(attachmentsApi, "getDownloadUrl").mockResolvedValue("https://files.example/voice")
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {})
    renderCards([
      audioAttachment({ audio: { status: "completed", durationMs: 83_000, waveform: WAVEFORM, normalized: true } }),
      audioAttachment({ id: "att_asis", filename: "asis.mp3", mimeType: "audio/mpeg" }),
    ])

    await user.click(within(card("voice.m4a")).getByRole("button", { name: "Download voice.m4a" }))
    await user.click(await screen.findByRole("menuitem", { name: "Download processed" }))
    await user.click(within(card("voice.m4a")).getByRole("button", { name: "Download voice.m4a" }))
    await user.click(await screen.findByRole("menuitem", { name: "Download original" }))
    await user.click(within(card("asis.mp3")).getByRole("button", { name: "Download asis.mp3" }))

    await waitFor(() => expect(getUrl).toHaveBeenCalledTimes(3))
    expect(getUrl.mock.calls).toEqual([
      [WS, "att_voice", { download: true, variant: "processed" }],
      [WS, "att_voice", { download: true, variant: "raw" }],
      [WS, "att_asis", { download: true, variant: "raw" }],
    ])
  })

  it("changes the playback rate from the speed menu and remembers it", async () => {
    const user = userEvent.setup()
    renderCards([audioAttachment()])
    await user.click(within(card("voice.m4a")).getByRole("button", { name: "Play" }))
    const element = playSpy.mock.contexts[0] as HTMLMediaElement

    await user.click(within(card("voice.m4a")).getByRole("button", { name: "Playback speed 1×" }))
    await user.click(await screen.findByRole("menuitemradio", { name: "1.5×" }))

    expect({
      rate: element.playbackRate,
      stored: loadMediaPreferences().playbackRate,
      label: within(card("voice.m4a"))
        .getByRole("button", { name: /^Playback speed/ })
        .getAttribute("aria-label"),
    }).toEqual({ rate: 1.5, stored: 1.5, label: "Playback speed 1.5×" })
  })

  it("starts playback from the position picked on an idle card's slider", () => {
    const seekSpy = vi.spyOn(HTMLMediaElement.prototype, "currentTime", "set").mockImplementation(() => {})
    renderCards([audioAttachment()])

    fireEvent.keyDown(within(card("voice.m4a")).getByRole("slider", { name: "Seek" }), { key: "End" })

    expect({ key: sessionTrack()?.key, startAt: seekSpy.mock.calls.at(-1)?.[0], play: playLabel("voice.m4a") }).toEqual(
      {
        key: "att_voice",
        startAt: 83,
        play: "Pause",
      }
    )
  })

  it("keeps the idle slider inert while the duration is unknown", () => {
    renderCards([audioAttachment({ audio: { status: "skipped" } })])

    expect(within(card("voice.m4a")).getByRole("slider", { name: "Seek" })).toHaveAttribute("data-disabled")
  })

  it("drops the filename and download row when the host shows its own", () => {
    render(<AudioPlayer trackKey="att_voice" filename="voice.m4a" sizeBytes={2048} resolveSrc={() => "blob:x"} />, {
      wrapper: Providers,
    })

    expect({
      filename: screen.queryByText("voice.m4a"),
      download: screen.queryByRole("button", { name: /^Download/ }),
      speed: screen.getByRole("button", { name: "Playback speed 1×" }).isConnected,
    }).toEqual({ filename: null, download: null, speed: true })
  })

  it("seeks with the arrow and End keys on the focused slider", async () => {
    const user = userEvent.setup()
    renderCards([audioAttachment()])
    await user.click(within(card("voice.m4a")).getByRole("button", { name: "Play" }))
    const seeks = trackSeeks(playSpy.mock.contexts[0] as HTMLMediaElement, 83)
    const slider = within(card("voice.m4a")).getByRole("slider", { name: "Seek" })

    fireEvent.keyDown(slider, { key: "ArrowRight" })
    fireEvent.keyDown(slider, { key: "ArrowRight" })
    fireEvent.keyDown(slider, { key: "ArrowLeft" })
    fireEvent.keyDown(slider, { key: "End" })

    expect(seeks.times).toEqual([5, 10, 5, 83])
    seeks.restore()
  })

  it("leaves keys pressed in its menus to the menu", async () => {
    const user = userEvent.setup()
    renderCards([audioAttachment()])
    const voiceCard = card("voice.m4a")
    await user.click(within(voiceCard).getByRole("button", { name: "Play" }))
    const element = playSpy.mock.contexts[0] as HTMLMediaElement
    const seeks = trackSeeks(element, 83)

    await user.click(within(voiceCard).getByRole("button", { name: "Playback speed 1×" }))
    const menu = await screen.findByRole("menu")
    fireEvent.keyDown(menu, { key: "ArrowRight" })
    fireEvent.keyDown(menu, { key: "k" })

    expect({ seeks: seeks.times, playing: sessionTrack()?.key, paused: paused.get(element) }).toEqual({
      seeks: [],
      playing: "att_voice",
      paused: false,
    })
    seeks.restore()
  })

  it("opens in the gallery, where the same track keeps playing and takes the player keys", async () => {
    const user = userEvent.setup()
    renderCards([
      audioAttachment(),
      audioAttachment({
        id: "att_song",
        filename: "song.wav",
        audio: { status: "completed", durationMs: 60_000, waveform: WAVEFORM, normalized: true },
      }),
    ])
    const voiceCard = card("voice.m4a")
    await user.click(within(voiceCard).getByRole("button", { name: "Play" }))
    const seeks = trackSeeks(playSpy.mock.contexts[0] as HTMLMediaElement, 83)

    await user.click(within(voiceCard).getByRole("button", { name: "Open voice.m4a" }))
    const gallery = await screen.findByRole("dialog", { name: "voice.m4a" })
    const slide = () =>
      within(gallery).getByRole("slider", { name: "Seek" }).closest<HTMLElement>("[data-audio-player]")!
    const opened = {
      playing: within(slide()).getByRole("button", { name: "Pause" }).isConnected,
      plays: playSpy.mock.calls.length,
      download: within(gallery).getByRole("button", { name: "Download" }).isConnected,
    }

    fireEvent.keyDown(gallery, { key: "ArrowRight" })
    fireEvent.keyDown(gallery, { key: " " })
    const afterKeys = {
      seeks: seeks.times,
      slide: within(slide()).getByRole("button", { name: "Play" }).isConnected,
      card: within(voiceCard)
        .getByRole("button", { name: /^(Play|Pause)$/, hidden: true })
        .getAttribute("aria-label"),
      showing: screen.getByRole("dialog").textContent?.includes("voice.m4a"),
    }

    fireEvent.keyDown(gallery, { key: "ArrowDown" })
    const next = await screen.findByRole("dialog", { name: "song.wav" })

    expect({
      opened,
      afterKeys,
      nextDownload: within(next).getByRole("button", { name: "Download audio" }).isConnected,
      track: sessionTrack()?.key,
    }).toEqual({
      opened: { playing: true, plays: 1, download: true },
      afterKeys: { seeks: [5], slide: true, card: "Play", showing: true },
      nextDownload: true,
      track: "att_voice",
    })
    seeks.restore()
  })
})

/** Gives the session's element a duration and records every position written to it. */
function trackSeeks(element: HTMLMediaElement, duration: number) {
  const times: number[] = []
  Object.defineProperty(element, "duration", { configurable: true, get: () => duration })
  Object.defineProperty(element, "currentTime", {
    configurable: true,
    get: () => times.at(-1) ?? 0,
    set: (t: number) => void times.push(t),
  })
  act(() => void element.dispatchEvent(new Event("durationchange")))
  return {
    times,
    restore() {
      delete (element as { duration?: number }).duration
      delete (element as { currentTime?: number }).currentTime
    },
  }
}

function BootstrapAttachments() {
  const { data } = useQuery<StreamBootstrap | null>({
    queryKey: streamKeys.bootstrap(WS, STREAM),
    queryFn: () => null,
    enabled: false,
    staleTime: Infinity,
  })
  const payload = data?.events[0]?.payload as { attachments?: AttachmentSummary[] } | undefined
  return <AttachmentList attachments={payload?.attachments ?? []} workspaceId={WS} />
}

describe("attachment:audio_processed", () => {
  it("turns a rendered pending card playable with its waveform", async () => {
    const queryClient = new QueryClient()
    queryClient.setQueryData(streamKeys.bootstrap(WS, STREAM), {
      events: [
        {
          id: "evt_1",
          streamId: STREAM,
          eventType: "message_created",
          payload: { messageId: "msg_1", attachments: [audioAttachment({ audio: { status: "pending" } })] },
        },
      ],
    } as unknown as StreamBootstrap)
    const handlers = new Map<string, (payload: unknown) => unknown>()
    const dispose = registerWorkspaceSocketHandlers(
      {
        on: (event: string, handler: (payload: unknown) => unknown) => void handlers.set(event, handler),
        off: (event: string) => void handlers.delete(event),
      },
      WS,
      queryClient,
      {
        getCurrentStreamId: () => STREAM,
        getCurrentUser: () => null,
        subscribeStream: vi.fn(),
        refreshWorkspace: vi.fn(),
      }
    )
    render(
      <QueryClientProvider client={queryClient}>
        <BootstrapAttachments />
      </QueryClientProvider>,
      { wrapper: Providers }
    )
    const before = {
      ...trackShape(card("voice.m4a")),
      disabled: within(card("voice.m4a")).getByRole("button", { name: "Play" }).hasAttribute("disabled"),
    }

    await act(async () => {
      await handlers.get("attachment:audio_processed")?.({
        workspaceId: WS,
        attachmentId: "att_voice",
        streamId: STREAM,
        messageId: "msg_1",
        audio: { status: "completed", durationMs: 83_000, waveform: WAVEFORM },
      })
    })

    await waitFor(() =>
      expect({
        before,
        after: {
          ...trackShape(card("voice.m4a")),
          disabled: within(card("voice.m4a")).getByRole("button", { name: "Play" }).hasAttribute("disabled"),
        },
      }).toEqual({
        before: { track: "plain", bars: 0, disabled: true },
        after: { track: "bars", bars: 128, disabled: false },
      })
    )
    dispose()
  })
})
