import { useEffect, useImperativeHandle, useState } from "react"
import { AlertCircle, Download, Loader2, Maximize2, Pause, Play } from "lucide-react"
import type { AttachmentAudioSummary, ProcessingStatus } from "@threahq/types"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { formatClock } from "@/lib/dates"
import { formatFileSize } from "@/lib/file-size"
import { clamp } from "@/lib/math-utils"
import { cn } from "@/lib/utils"
import { DownloadVariantsMenu } from "./download-variants-menu"
import { audioSession, useAudioPlaybackRate, useAudioScopeId, useAudioSessionElement } from "./audio-session"
import { mediaKeyAction, type MediaKeyEvent, type MediaKeyHandle } from "./media-keys"
import { PLAYBACK_RATES, formatPlaybackRate } from "./preferences"
import { useMediaPlayback } from "./use-media-playback"
import { SCRUB_SELECTOR } from "./use-scrub"
import { WaveformScrub } from "./waveform"

/** Completed processing has a playable `processed` variant; every other state plays the original bytes. */
export function playableAudioVariant(status: ProcessingStatus | undefined): "processed" | "raw" {
  return status === "completed" ? "processed" : "raw"
}

export interface AudioPlayerProps {
  /** Session key: the attachment id. */
  trackKey: string
  filename: string
  sizeBytes: number
  audio?: AttachmentAudioSummary
  /** The playable source, read when play is pressed. A `blob:` URL is handed to the session, which revokes it. */
  resolveSrc(): string | Promise<string>
  /** Downloads the upload as it was sent. Omitted by hosts that show the filename and their own download: the card is then one row of controls. */
  onDownload?(): Promise<unknown>
  /** Downloads the normalized file. With it the download button offers both, like the gallery does for video. */
  onDownloadProcessed?(): Promise<unknown>
  /** Opens the track in the gallery; the card then shows a button for it. */
  onExpand?(): void
  /** The gallery's form: a tall waveform above the controls. */
  stage?: boolean
  isHighlighted?: boolean
  className?: string
  /** A host that takes the handle dispatches keys itself; without one the card handles keys pressed inside it. */
  ref?: React.Ref<MediaKeyHandle>
}

const iconButtonClass = "h-10 w-10 shrink-0 rounded-full"

function SpeedMenu({ rate }: { rate: number }) {
  const label = formatPlaybackRate(rate)
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          className="h-10 min-w-10 shrink-0 rounded-full px-2 text-xs font-medium tabular-nums"
          aria-label={`Playback speed ${label}`}
        >
          {label}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[6.5rem]">
        <DropdownMenuRadioGroup value={String(rate)} onValueChange={(v) => audioSession.setPlaybackRate(Number(v))}>
          {PLAYBACK_RATES.map((r) => (
            <DropdownMenuRadioItem key={r} value={String(r)} className="tabular-nums">
              {formatPlaybackRate(r)}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

interface DownloadButtonProps {
  filename: string
  onDownload(): Promise<unknown>
  onDownloadProcessed?(): Promise<unknown>
}

function DownloadButton({ filename, onDownload, onDownloadProcessed }: DownloadButtonProps) {
  const [busy, setBusy] = useState(false)
  const run = async (download: () => Promise<unknown>) => {
    setBusy(true)
    try {
      await download()
    } finally {
      setBusy(false)
    }
  }
  const button = (
    <Button
      variant="ghost"
      size="icon"
      className={iconButtonClass}
      aria-label={`Download ${filename}`}
      disabled={busy}
      onClick={onDownloadProcessed ? undefined : () => run(onDownload)}
    >
      {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
    </Button>
  )
  if (!onDownloadProcessed) return button
  return (
    <DownloadVariantsMenu onProcessed={() => run(onDownloadProcessed)} onOriginal={() => run(onDownload)}>
      {button}
    </DownloadVariantsMenu>
  )
}

function PlayButtonIcon({ waiting, playing }: { waiting: boolean; playing: boolean }) {
  if (waiting) return <Loader2 className="h-5 w-5 animate-spin" />
  if (playing) return <Pause className="h-5 w-5" fill="currentColor" />
  return <Play className="ml-0.5 h-5 w-5" fill="currentColor" />
}

export function AudioPlayer({
  trackKey,
  filename,
  sizeBytes,
  audio,
  resolveSrc,
  onDownload,
  onDownloadProcessed,
  onExpand,
  stage = false,
  isHighlighted,
  className,
  ref,
}: AudioPlayerProps) {
  const element = useAudioSessionElement(trackKey)
  // The session owns the shared element's rate, and the card has no volume control to undo a stored mute.
  const playback = useMediaPlayback(element, { appliesPreferences: false })
  const playbackRate = useAudioPlaybackRate()
  const scope = useAudioScopeId()
  const [resolving, setResolving] = useState(false)
  const [resolveFailed, setResolveFailed] = useState(false)
  const [idleScrubTime, setIdleScrubTime] = useState<number | null>(null)

  // Outside an AudioScope nothing else ends the track, so it ends with its card. The gallery's slide
  // always sits over that card, so closing it ends nothing.
  useEffect(() => {
    if (scope !== null || stage) return
    return () => audioSession.stopUnscoped(trackKey)
  }, [scope, stage, trackKey])

  const active = element !== null
  const processing = audio?.status === "pending" || audio?.status === "processing"
  const failed = resolveFailed || (active && playback.failed)
  const playing = active && !playback.paused && !failed
  const waiting = processing || resolving || (active && playback.busy)
  const knownDuration = (audio?.durationMs ?? 0) / 1000
  const duration = active && playback.duration > 0 ? playback.duration : knownDuration
  const time = active ? playback.time : (idleScrubTime ?? 0)
  const durationLabel = formatClock(duration)

  const startPlayback = async (startAt?: number) => {
    const track = { key: trackKey, scope, title: filename }
    const src = resolveSrc()
    // A string source starts inside the gesture, where the browser still grants playback.
    if (typeof src === "string") {
      audioSession.start({ ...track, src }, startAt)
      return
    }
    const begin = audioSession.prepare(track, startAt)
    setResolveFailed(false)
    setResolving(true)
    try {
      begin(await src)
    } catch {
      setResolveFailed(true)
    } finally {
      setResolving(false)
    }
  }

  const handlePlay = () => {
    if (!active) return startPlayback()
    if (playback.paused) audioSession.resume()
    else playback.togglePlay()
  }

  const startFrom = (at: number) => {
    setIdleScrubTime(null)
    void startPlayback(at)
  }

  // Until the first play the slider picks the start position: a click, drag release or key press plays from there.
  const scrubHandlers = active
    ? {
        scrubbing: playback.scrubbing,
        onScrubStart: playback.beginScrub,
        onScrub: playback.scrubTo,
        onScrubEnd: playback.endScrub,
        onSeek: playback.seek,
      }
    : {
        scrubbing: idleScrubTime !== null,
        onScrubStart: () => {},
        onScrub: setIdleScrubTime,
        onScrubEnd: () => {
          if (idleScrubTime !== null) startFrom(idleScrubTime)
        },
        onSeek: startFrom,
      }

  const playDisabled = processing || resolving || (active && playback.failed)
  const seekTo = (target: number) => {
    if (active) playback.seek(target)
    else startFrom(target)
  }
  const handleKey = (e: MediaKeyEvent & Pick<KeyboardEvent, "preventDefault">): boolean => {
    // The speed and download menus render in a portal, but their keys still bubble through the card.
    const inMenu = e.target instanceof Element && !!e.target.closest('[role="menu"]')
    if (playDisabled || inMenu) return false
    const action = mediaKeyAction(e, SCRUB_SELECTOR)
    if (action?.type === "toggle-play") handlePlay()
    else if (action?.type === "nudge" && duration > 0) {
      seekTo(clamp(time + action.direction * action.seconds, 0, duration))
    } else if (action?.type === "seek-fraction" && duration > 0) seekTo(duration * action.fraction)
    else return false
    e.preventDefault()
    return true
  }
  useImperativeHandle(ref, () => ({ handleKeyDown: handleKey }))

  const speedMenu = <SpeedMenu rate={playbackRate} />
  const playButton = (
    <Button
      variant="secondary"
      size="icon"
      className={cn("shrink-0 rounded-full", stage ? "h-12 w-12" : "h-10 w-10")}
      aria-label={playing ? "Pause" : "Play"}
      disabled={playDisabled}
      onClick={handlePlay}
    >
      <PlayButtonIcon waiting={waiting} playing={playing} />
    </Button>
  )
  const scrub = failed ? (
    <div role="alert" className="flex h-10 items-center gap-1.5 text-xs text-muted-foreground">
      <AlertCircle className="h-4 w-4 shrink-0" />
      <span className="truncate">Can't play this file</span>
    </div>
  ) : (
    <WaveformScrub
      waveform={audio?.waveform}
      tall={stage}
      time={time}
      duration={duration}
      disabled={!active && (processing || resolving)}
      {...scrubHandlers}
    />
  )
  const clock = (
    <span className="shrink-0 whitespace-nowrap pr-1 text-xs tabular-nums text-muted-foreground">
      <span className="inline-block text-right" style={{ minWidth: `${durationLabel.length}ch` }}>
        {formatClock(time, duration)}
      </span>
      {" / "}
      {durationLabel}
    </span>
  )

  if (stage) {
    return (
      <div
        data-audio-player=""
        data-gallery-owns-touch=""
        className={cn("flex w-full max-w-2xl flex-col gap-2 rounded-lg border bg-card p-4 shadow-2xl", className)}
      >
        {scrub}
        <div className="flex items-center gap-3">
          {playButton}
          {clock}
          <span className="flex-1" />
          {speedMenu}
        </div>
      </div>
    )
  }

  return (
    <div
      data-audio-player=""
      data-highlighted={isHighlighted || undefined}
      className={cn(
        "flex w-full max-w-sm flex-col rounded-lg border bg-muted/30 px-1.5 transition-shadow",
        onDownload ? "pb-1.5" : "py-1.5",
        isHighlighted && "ring-2 ring-primary border-primary shadow-sm",
        className
      )}
      onKeyDown={ref ? undefined : (e) => void handleKey(e.nativeEvent)}
    >
      {onDownload && (
        <div className="flex items-center gap-1">
          <span className="min-w-0 flex-1 truncate pl-1.5 text-xs">
            <span className="font-medium">{filename}</span>
            <span className="text-muted-foreground"> · {formatFileSize(sizeBytes)}</span>
          </span>
          {speedMenu}
          <DownloadButton filename={filename} onDownload={onDownload} onDownloadProcessed={onDownloadProcessed} />
          {onExpand && (
            <Button
              variant="ghost"
              size="icon"
              className={iconButtonClass}
              aria-label={`Open ${filename}`}
              onClick={onExpand}
            >
              <Maximize2 className="h-4 w-4" />
            </Button>
          )}
        </div>
      )}
      <div className="flex items-center gap-2">
        {playButton}
        <div className="min-w-0 flex-1">{scrub}</div>
        {clock}
        {!onDownload && speedMenu}
      </div>
    </div>
  )
}
