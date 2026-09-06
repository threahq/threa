import type { ReactNode } from "react"
import { Link } from "react-router-dom"
import type { ActorHrefPointer } from "@threahq/prosemirror"
import { cn } from "@/lib/utils"
import { InAppLinkChip } from "@/components/in-app-link/in-app-link-chip"
import { chipBase, triggerStyles } from "./chip-styles"
import { useMentionType, useMentionClick, useIsMentionOnlyBot } from "./mention-context"
import { useChannelUrl, useChannelUrlById } from "./channel-link-context"
import { useEmojiLookup } from "./emoji-context"
import { useIsKnownCommand } from "./command-list-context"
import { StreamChip } from "./stream-chip"
import { MENTION_PATTERN, isValidSlug } from "@threahq/types"

interface TriggerChipProps {
  type: "mention" | "channel" | "command"
  text: string
}

/**
 * A personal bot the viewer doesn't own: mentionable, never invocable by them
 * (the backend dispatches owner mentions only). Amber + dashed underline so
 * the chip itself signals it; the title explains on hover.
 */
const mentionOnlyStyle =
  "bg-amber-500/10 text-amber-600 dark:text-amber-400 underline decoration-dashed underline-offset-2"
const mentionOnlyTitle = "Personal bot: you can mention it, but only its owner can invoke it. It won't respond to you."

/**
 * Navigable wrapper for a `#` chip. The chip carries its own background and
 * padding, so the anchor only routes — `no-underline` keeps it from drawing a
 * second line under the pill, matching how a posted in-app link wraps the same
 * chip ({@link InAppLinkInline}).
 */
function StreamChipLink({ to, children }: { to: string; children: ReactNode }) {
  return (
    <Link to={to} className="no-underline">
      {children}
    </Link>
  )
}

/** Channel chips render as links; mentions and commands render as spans. */
function TriggerChip({ type, text }: TriggerChipProps) {
  const getMentionType = useMentionType()
  const getChannelUrl = useChannelUrl()
  const onMentionClick = useMentionClick()
  const isMentionOnlyBot = useIsMentionOnlyBot()

  if (type === "channel") {
    // A bare `#slug` names a channel by definition (INV-64's lenient input), so
    // it always reads as the sigil-prefixed form.
    const chip = <InAppLinkChip prefix="#" label={text} />
    const url = getChannelUrl(text)
    return url ? <StreamChipLink to={url}>{chip}</StreamChipLink> : chip
  }

  let style: string
  let prefix: string

  switch (type) {
    case "command":
      style = triggerStyles.command
      prefix = "/"
      break
    default:
      style = triggerStyles[getMentionType(text)]
      prefix = "@"
  }

  const mentionType = type === "mention" ? getMentionType(text) : null
  const isClickable = onMentionClick && (mentionType === "user" || mentionType === "me")

  if (isClickable) {
    return (
      <button
        type="button"
        onClick={() => onMentionClick(text, mentionType)}
        className={cn(chipBase, "cursor-pointer hover:underline", style)}
      >
        {prefix}
        {text}
      </button>
    )
  }

  const mentionOnly = mentionType === "bot" && isMentionOnlyBot(text)
  return (
    <span
      className={cn(chipBase, mentionOnly ? mentionOnlyStyle : style)}
      title={mentionOnly ? mentionOnlyTitle : undefined}
    >
      {prefix}
      {text}
    </span>
  )
}

/**
 * Render a pointer-link mention/channel (`[@slug](user:usr_x)` etc.) as a chip.
 * The type comes from the URL scheme (authoritative, INV-64) — not the slug→type
 * map the bare-slug path falls back to — and navigation uses the embedded id, so
 * a renamed slug never mis-colors or breaks the link. A `#` chip draws through
 * {@link StreamChip}, the same chip a pasted stream link renders. `@` chips keep
 * the authored slug — the actor caches they'd resolve through are a separate
 * surface.
 */
export function PointerMentionChip({ pointer, slug }: { pointer: ActorHrefPointer; slug: string }) {
  const getChannelUrlById = useChannelUrlById()
  const getMentionType = useMentionType()
  const onMentionClick = useMentionClick()
  const isMentionOnlyBot = useIsMentionOnlyBot()

  if (pointer.kind === "channel") {
    const chip = <StreamChip id={pointer.id} slug={slug} />
    const url = getChannelUrlById(pointer.id)
    return url ? <StreamChipLink to={url}>{chip}</StreamChipLink> : chip
  }

  // "me" is viewer-relative; the scheme only knows "user", so upgrade to the
  // "me" styling when the slug resolves to the current viewer.
  const displayType = pointer.mentionType === "user" && getMentionType(slug) === "me" ? "me" : pointer.mentionType
  const style = triggerStyles[displayType]
  const isClickable = onMentionClick && pointer.mentionType === "user"

  if (isClickable) {
    return (
      <button
        type="button"
        onClick={() => onMentionClick(slug, displayType, pointer.id)}
        className={cn(chipBase, "cursor-pointer hover:underline", style)}
      >
        @{slug}
      </button>
    )
  }

  // Pointer mentions carry the authoritative id (INV-64) — check by it, so a
  // renamed slug can't dodge the signal.
  const mentionOnly = pointer.mentionType === "bot" && isMentionOnlyBot(pointer.id)
  return (
    <span
      className={cn(chipBase, mentionOnly ? mentionOnlyStyle : style)}
      title={mentionOnly ? mentionOnlyTitle : undefined}
    >
      @{slug}
    </span>
  )
}

// `(?=\s|$)` keeps the command name a whole token, so a path segment like the
// `/model` in `/model/checkpoints` isn't rendered as a `/model` command chip.
const COMMAND_PATTERN = /^(\s*)(\/)([\w-]+)(?=\s|$)/

const CHANNEL_PATTERN = /(?<![a-z0-9])#([a-z][a-z0-9-]*[a-z0-9]|[a-z])(?![a-z0-9_.-])/g

const EMOJI_PATTERN = /:([a-z0-9_+-]+):/g

type ToEmoji = (shortcode: string) => string | null
type IsKnownCommand = (name: string) => boolean

/**
 * Parse text and render triggers as styled chips, emojis as characters.
 * Returns an array of React nodes.
 *
 * A leading "/word" is only rendered as a command chip when `isKnownCommand`
 * returns true for the name. Defaults to rejecting all, so plain text like
 * "/s" stays as text unless a CommandListProvider is mounted.
 */
export function renderMentions(
  text: string,
  toEmoji: ToEmoji,
  isKnownCommand: IsKnownCommand = () => false
): ReactNode[] {
  const result: ReactNode[] = []
  let processText = text
  let keyIndex = 0

  const commandMatch = processText.match(COMMAND_PATTERN)
  if (commandMatch && isKnownCommand(commandMatch[3])) {
    if (commandMatch[1]) {
      result.push(commandMatch[1])
    }
    result.push(<TriggerChip key={`cmd-${keyIndex++}`} type="command" text={commandMatch[3]} />)
    processText = processText.slice(commandMatch[0].length)
  }

  type TriggerMatch =
    | { index: number; length: number; type: "mention" | "channel"; slug: string }
    | { index: number; length: number; type: "emoji"; shortcode: string; emoji: string }
  const triggers: TriggerMatch[] = []

  const mentionPattern = new RegExp(MENTION_PATTERN.source, MENTION_PATTERN.flags)
  let match
  while ((match = mentionPattern.exec(processText)) !== null) {
    if (isValidSlug(match[1])) {
      triggers.push({ index: match.index, length: match[0].length, type: "mention", slug: match[1] })
    }
  }

  // Clone the global regex so concurrent calls don't share lastIndex.
  const channelPattern = new RegExp(CHANNEL_PATTERN.source, CHANNEL_PATTERN.flags)
  while ((match = channelPattern.exec(processText)) !== null) {
    if (isValidSlug(match[1])) {
      triggers.push({ index: match.index, length: match[0].length, type: "channel", slug: match[1] })
    }
  }

  const emojiPattern = new RegExp(EMOJI_PATTERN.source, EMOJI_PATTERN.flags)
  while ((match = emojiPattern.exec(processText)) !== null) {
    const shortcode = match[1]
    const emoji = toEmoji(shortcode)
    if (emoji) {
      triggers.push({ index: match.index, length: match[0].length, type: "emoji", shortcode, emoji })
    }
  }

  triggers.sort((a, b) => a.index - b.index)

  let lastIndex = 0
  for (const trigger of triggers) {
    if (trigger.index < lastIndex) continue

    if (trigger.index > lastIndex) {
      result.push(processText.slice(lastIndex, trigger.index))
    }

    if (trigger.type === "emoji") {
      result.push(
        <span key={`${keyIndex++}-emoji-${trigger.shortcode}`} title={`:${trigger.shortcode}:`}>
          {trigger.emoji}
        </span>
      )
    } else {
      result.push(
        <TriggerChip key={`${keyIndex++}-${trigger.type}-${trigger.slug}`} type={trigger.type} text={trigger.slug} />
      )
    }
    lastIndex = trigger.index + trigger.length
  }

  if (lastIndex < processText.length) {
    result.push(processText.slice(lastIndex))
  }

  return result.length > 0 ? result : [text]
}

export function ProcessedChildren({ children }: { children: ReactNode }): ReactNode {
  const toEmoji = useEmojiLookup()
  const isKnownCommand = useIsKnownCommand()
  return processChildrenForMentions(children, toEmoji, isKnownCommand)
}

/** Preserves non-text children (like <strong>, <em>) unchanged. */
export function processChildrenForMentions(
  children: ReactNode,
  toEmoji: ToEmoji,
  isKnownCommand: IsKnownCommand = () => false
): ReactNode {
  if (typeof children === "string") {
    const rendered = renderMentions(children, toEmoji, isKnownCommand)
    return rendered.length === 1 && typeof rendered[0] === "string" ? rendered[0] : <>{rendered}</>
  }

  if (Array.isArray(children)) {
    return children.map((child, index) => (
      <span key={index}>{processChildrenForMentions(child, toEmoji, isKnownCommand)}</span>
    ))
  }

  return children
}
