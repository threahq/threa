import { useEffect, useImperativeHandle, useRef, useState } from "react"
import * as SliderPrimitive from "@radix-ui/react-slider"
import {
  FastForward,
  Loader2,
  Maximize,
  Minimize,
  Pause,
  Play,
  Rewind,
  VideoOff,
  Volume1,
  Volume2,
  VolumeX,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { useInputMode } from "@/hooks/use-input-mode"
import { useIsMobile } from "@/hooks/use-mobile"
import { DOUBLE_TAP_MS } from "@/hooks/use-zoom-pan"
import { formatClock } from "@/lib/dates"
import { cn } from "@/lib/utils"
import {
  isNudgeChainActive,
  tapZone,
  zoneDirection,
  type NudgeChain,
  type NudgeDirection,
  type TapZone,
} from "./gestures"
import { mediaKeyAction } from "./media-keys"
import { PLAYBACK_RATES, formatPlaybackRate } from "./preferences"
import { SCRUB_SELECTOR, ScrubBar } from "./scrub-bar"
import { useFullscreen } from "./use-fullscreen"
import { useMediaPlayback } from "./use-media-playback"

const NUDGE_SECONDS = 10

export interface VideoPlayerHandle {
  /** Applies a player shortcut; returns true when the key was consumed. */
  handleKeyDown(e: KeyboardEvent): boolean
}

export interface VideoPlayerProps {
  src: string
  poster?: string
  filename: string
  /** Owned by the gallery; the player's chrome fades and goes inert with it. */
  chromeVisible: boolean
  /** Touch tap on the video: the gallery decides whether the chrome toggles. */
  onChromeTap(): void
  /** Reports playback state on every change and on each chrome interaction. */
  onActivity(playing: boolean): void
  ref?: React.Ref<VideoPlayerHandle>
}

function volumeIcon(level: number) {
  if (level === 0) return VolumeX
  return level < 0.5 ? Volume1 : Volume2
}

const chromeButtonClass = "h-10 w-10 shrink-0 rounded-full text-white hover:bg-white/20 hover:text-white"

function ChromeButton({
  label,
  className,
  children,
  ...props
}: React.ComponentProps<typeof Button> & { label: string }) {
  return (
    <Button variant="ghost" size="icon" className={cn(chromeButtonClass, className)} {...props}>
      {children}
      <span className="sr-only">{label}</span>
    </Button>
  )
}

function NudgeIndicator({
  side,
  chain,
  visible,
}: {
  side: NudgeDirection
  chain: NudgeChain | null
  visible: boolean
}) {
  const lastRef = useRef<NudgeChain | null>(null)
  if (chain?.direction === side) lastRef.current = chain
  const shown = lastRef.current
  const Icon = side < 0 ? Rewind : FastForward
  return (
    <div
      aria-hidden
      className={cn(
        "pointer-events-none absolute top-1/2 flex h-[72px] w-[72px] -translate-x-1/2 -translate-y-1/2 flex-col items-center justify-center gap-0.5 rounded-full bg-black/45 text-white backdrop-blur-sm transition-opacity duration-200",
        side < 0 ? "left-[16.667%]" : "left-[83.333%]",
        visible && chain?.direction === side ? "opacity-100" : "opacity-0"
      )}
    >
      <Icon className="h-6 w-6" fill="currentColor" />
      <span className="text-xs font-medium tabular-nums">{shown ? `${shown.totalSeconds}s` : ""}</span>
    </div>
  )
}

function VolumeSlider({ value, onChange }: { value: number; onChange(value: number): void }) {
  return (
    <SliderPrimitive.Root
      value={[value]}
      min={0}
      max={1}
      step={0.05}
      onValueChange={([v]) => onChange(v)}
      className="group/volume relative flex h-10 w-20 shrink-0 cursor-pointer touch-none select-none items-center"
    >
      <SliderPrimitive.Track className="relative h-1 w-full overflow-hidden rounded-full bg-white/25">
        <SliderPrimitive.Range className="absolute h-full bg-white" />
      </SliderPrimitive.Track>
      <SliderPrimitive.Thumb
        aria-label="Volume"
        aria-valuetext={`${Math.round(value * 100)}%`}
        className="block h-3 w-3 rounded-full bg-white shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
      />
    </SliderPrimitive.Root>
  )
}

function SpeedMenu({
  rate,
  container,
  onSelect,
}: {
  rate: number
  container: HTMLElement | null
  onSelect(rate: number): void
}) {
  const label = formatPlaybackRate(rate)
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          className="h-10 w-14 shrink-0 rounded-full px-0 text-xs font-medium tabular-nums text-white hover:bg-white/20 hover:text-white"
          aria-label={`Playback speed ${label}`}
        >
          {label}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        container={container}
        side="top"
        align="end"
        sideOffset={6}
        className="min-w-[6.5rem] rounded-lg border-white/10 bg-black/85 text-white shadow-lg backdrop-blur-md"
      >
        <DropdownMenuRadioGroup value={String(rate)} onValueChange={(v) => onSelect(Number(v))}>
          {PLAYBACK_RATES.map((r) => (
            <DropdownMenuRadioItem
              key={r}
              value={String(r)}
              className="tabular-nums text-white focus:bg-white/15 focus:text-white"
            >
              {formatPlaybackRate(r)}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function VideoPlayer({ src, poster, filename, chromeVisible, onChromeTap, onActivity, ref }: VideoPlayerProps) {
  const [root, setRoot] = useState<HTMLDivElement | null>(null)
  const [video, setVideo] = useState<HTMLVideoElement | null>(null)
  const [controls, setControls] = useState<HTMLDivElement | null>(null)
  const [aspect, setAspect] = useState(16 / 9)
  const playback = useMediaPlayback(video)
  const fullscreen = useFullscreen(root, video)
  const touch = useInputMode() === "touch"
  const isMobile = useIsMobile()
  const lastTapRef = useRef<{ zone: TapZone; at: number } | null>(null)

  const onActivityRef = useRef(onActivity)
  onActivityRef.current = onActivity
  const pausedRef = useRef(playback.paused)
  pausedRef.current = playback.paused

  useEffect(() => {
    root?.focus({ preventScroll: true })
  }, [root])

  useEffect(() => {
    onActivityRef.current(!playback.paused)
  }, [playback.paused])

  useEffect(() => {
    if (chromeVisible && !pausedRef.current) onActivityRef.current(true)
  }, [chromeVisible])

  useEffect(() => () => onActivityRef.current(false), [])

  useImperativeHandle(
    ref,
    () => ({
      handleKeyDown(e) {
        const action = mediaKeyAction(e, SCRUB_SELECTOR)
        if (!action) return false
        e.preventDefault()
        switch (action.type) {
          case "toggle-play":
            playback.togglePlay()
            break
          case "nudge":
            playback.nudgeBy(action.direction, action.seconds)
            break
          case "step-frame":
            playback.stepFrame(action.direction)
            break
          case "toggle-mute":
            playback.toggleMute()
            break
          case "toggle-fullscreen":
            if (fullscreen.available) fullscreen.toggle()
            break
          case "seek-fraction":
            playback.seekFraction(action.fraction)
            break
          case "step-rate":
            playback.stepPlaybackRate(action.direction)
            break
        }
        return true
      },
    }),
    [playback, fullscreen]
  )

  const handleSurfaceClick = (e: React.MouseEvent<HTMLDivElement>) => {
    // The gallery's own tap handling (edge navigation, chrome toggle) never sees the player.
    e.stopPropagation()
    if (e.target instanceof Element && e.target.closest("[data-media-controls]")) return
    const rect = e.currentTarget.getBoundingClientRect()
    const zone = tapZone(e.clientX - rect.left, rect.width)
    const direction = zoneDirection(zone)
    const now = Date.now()
    if (direction !== null && isNudgeChainActive(playback.nudge, now)) {
      lastTapRef.current = null
      playback.nudgeBy(direction, NUDGE_SECONDS)
      return
    }
    const prev = lastTapRef.current
    const isDouble = direction !== null && prev?.zone === zone && now - prev.at < DOUBLE_TAP_MS
    lastTapRef.current = isDouble ? null : { zone, at: now }
    // The second tap of a double undoes the first: the gallery drops a pending
    // chrome toggle, and a mouse play/pause toggles back.
    if (touch) onChromeTap()
    else playback.togglePlay()
    if (isDouble) playback.nudgeBy(direction, NUDGE_SECONDS)
  }

  const chromeHidden = !chromeVisible
  // Touch has no click-to-pause: its play/pause is the centre button, which comes and goes with the chrome.
  const centerHidden = playback.started && chromeHidden
  const buffering = playback.busy && playback.started && !playback.failed
  const CenterIcon = playback.paused ? Play : Pause
  const durationLabel = formatClock(playback.duration)
  const VolumeIcon = volumeIcon(playback.muted ? 0 : playback.volume)

  return (
    <div
      ref={setRoot}
      data-media-player=""
      tabIndex={-1}
      className={cn(
        "absolute inset-0 flex select-none items-center justify-center outline-none",
        chromeHidden && !playback.paused && !touch && "cursor-none"
      )}
      onClick={handleSurfaceClick}
    >
      <video
        ref={setVideo}
        src={src}
        poster={poster}
        playsInline
        preload="metadata"
        className={cn(
          "max-h-full max-w-full object-contain transition-opacity duration-150",
          playback.scrubbing && playback.busy && "opacity-60"
        )}
        onLoadedMetadata={(e) => {
          const v = e.currentTarget
          if (v.videoWidth > 0 && v.videoHeight > 0) setAspect(v.videoWidth / v.videoHeight)
        }}
      />

      {playback.failed && (
        <div
          role="alert"
          className="pointer-events-none absolute left-1/2 top-1/2 flex -translate-x-1/2 -translate-y-1/2 flex-col items-center gap-2 text-white/80"
        >
          <VideoOff className="h-9 w-9" />
          <span className="text-sm">Can't play this video</span>
        </div>
      )}

      {!playback.failed && (touch || !playback.started) && (
        <button
          type="button"
          data-gallery-chrome=""
          className={cn(
            "absolute left-1/2 top-1/2 flex -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-white/10 text-white backdrop-blur-sm transition-[opacity,background-color] duration-200 hover:bg-white/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60",
            touch ? "h-20 w-20" : "h-16 w-16",
            centerHidden && "pointer-events-none opacity-0"
          )}
          inert={centerHidden || undefined}
          onClick={(e) => {
            e.stopPropagation()
            playback.togglePlay()
          }}
        >
          {buffering && (
            <Loader2 className="absolute inset-0 h-full w-full animate-spin text-white/70" strokeWidth={1} />
          )}
          <CenterIcon className={cn(touch ? "h-9 w-9" : "h-7 w-7", playback.paused && "ml-0.5")} fill="currentColor" />
          <span className="sr-only">{playback.paused ? "Play" : "Pause"}</span>
        </button>
      )}

      {buffering && (!touch || centerHidden) && (
        <Loader2 className="pointer-events-none absolute left-1/2 top-1/2 h-9 w-9 -translate-x-1/2 -translate-y-1/2 animate-spin text-white/80" />
      )}

      <NudgeIndicator side={-1} chain={playback.nudge} visible={playback.nudgeVisible} />
      <NudgeIndicator side={1} chain={playback.nudge} visible={playback.nudgeVisible} />

      <div
        data-gallery-chrome=""
        data-media-chrome=""
        className={cn(
          "absolute inset-x-0 bottom-0 z-10 flex flex-col bg-gradient-to-t from-black/85 via-black/50 to-transparent pt-12",
          "pb-[max(0.25rem,env(safe-area-inset-bottom))] pl-[max(1rem,env(safe-area-inset-left))] pr-[max(1rem,env(safe-area-inset-right))]",
          "transition-opacity duration-200",
          chromeHidden && "pointer-events-none opacity-0"
        )}
        inert={chromeHidden || undefined}
        onPointerDown={() => onActivity(!playback.paused)}
      >
        <span className="truncate text-sm text-white">{filename}</span>
        {/* Only the controls own touches and clicks; the gradient above them stays part of the video surface. */}
        <div ref={setControls} data-gallery-owns-touch="" data-media-controls="" className="flex flex-col">
          <ScrubBar
            src={src}
            aspect={aspect}
            time={playback.time}
            duration={playback.duration}
            buffered={playback.buffered}
            scrubbing={playback.scrubbing}
            touch={touch}
            onScrubStart={playback.beginScrub}
            onScrub={playback.scrubTo}
            onScrubEnd={playback.endScrub}
            onSeek={playback.seek}
          />
          <div className="-mx-2 flex items-center gap-0.5">
            {!touch && (
              <ChromeButton label={playback.paused ? "Play" : "Pause"} onClick={playback.togglePlay}>
                {playback.paused ? (
                  <Play className="h-5 w-5" fill="currentColor" />
                ) : (
                  <Pause className="h-5 w-5" fill="currentColor" />
                )}
              </ChromeButton>
            )}
            <span className={cn("whitespace-nowrap text-xs tabular-nums text-white/90", touch ? "ml-2" : "ml-1")}>
              <span className="inline-block text-right" style={{ minWidth: `${durationLabel.length}ch` }}>
                {formatClock(playback.time, playback.duration)}
              </span>
              <span className="text-white/60"> / {durationLabel}</span>
            </span>
            <div className="flex-1" />
            <ChromeButton label={playback.muted ? "Unmute" : "Mute"} onClick={playback.toggleMute}>
              <VolumeIcon className="h-5 w-5" />
            </ChromeButton>
            {!isMobile && <VolumeSlider value={playback.muted ? 0 : playback.volume} onChange={playback.setVolume} />}
            <SpeedMenu rate={playback.playbackRate} container={controls} onSelect={playback.setPlaybackRate} />
            {fullscreen.available && (
              <ChromeButton label={fullscreen.active ? "Exit full screen" : "Full screen"} onClick={fullscreen.toggle}>
                {fullscreen.active ? <Minimize className="h-5 w-5" /> : <Maximize className="h-5 w-5" />}
              </ChromeButton>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
