import type { ReactNode } from "react"
import { Link } from "react-router-dom"
import { cn } from "@/lib/utils"
import { useMentionType, useMentionClick } from "./mention-context"
import { useChannelUrl } from "./channel-link-context"
import { useEmojiLookup } from "./emoji-context"
import { useIsKnownCommand } from "./command-list-context"
import { MENTION_PATTERN, isValidSlug } from "@threa/types"

// Colors match the design system kitchen sink.
export const triggerStyles = {
  user: "bg-[hsl(200_70%_50%/0.1)] text-[hsl(200_70%_50%)]",
  persona: "bg-primary/10 text-primary",
  bot: "bg-green-500/10 text-green-600 dark:text-green-400",
  broadcast: "bg-orange-500/10 text-orange-600 dark:text-orange-400",
  channel: "bg-muted text-foreground",
  command: "bg-[hsl(280_60%_55%/0.15)] text-[hsl(280_60%_55%)] font-mono",
  me: "bg-[hsl(200_70%_50%/0.15)] text-primary font-semibold",
}

interface TriggerChipProps {
  type: "mention" | "channel" | "command"
  text: string
}

export const chipBase = "inline px-1 py-px rounded font-medium"

/** Channel chips render as links; mentions and commands render as spans. */
function TriggerChip({ type, text }: TriggerChipProps) {
  const getMentionType = useMentionType()
  const getChannelUrl = useChannelUrl()
  const onMentionClick = useMentionClick()

  if (type === "channel") {
    const url = getChannelUrl(text)
    if (url) {
      return (
        <Link
          to={url}
          className={cn(chipBase, "hover:underline underline-offset-2 decoration-current/50", triggerStyles.channel)}
        >
          #{text}
        </Link>
      )
    }
    return <span className={cn(chipBase, triggerStyles.channel)}>#{text}</span>
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

  return (
    <span className={cn(chipBase, "cursor-pointer", style)}>
      {prefix}
      {text}
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
