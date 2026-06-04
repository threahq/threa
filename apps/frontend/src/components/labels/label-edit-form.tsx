import { useState, type FormEvent, type ReactNode } from "react"
import { SmilePlus, X } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Label as UiLabel } from "@/components/ui/label"
import { ReactionEmojiPicker } from "@/components/timeline/reaction-emoji-picker"
import { cn } from "@/lib/utils"
import { useUpdateLabel, type CachedLabel } from "@/hooks"

// A curated palette of saturated, distinct colors that read well as full-bleed
// swatches. Users can override via hex input; these are the suggestions.
export const PRESET_COLORS = [
  "#E04F3E",
  "#F0A030",
  "#E8C547",
  "#8AB04F",
  "#39A07A",
  "#3A91C7",
  "#4D5BA8",
  "#8654C2",
  "#C04C8E",
  "#1E1E1E",
] as const

export const PRESET_EMOJIS = ["🏷️", "🌱", "🔥", "🧠", "📚", "🛠️", "🎯", "💡", "✨", "🪐", "🌊", "⚡"] as const

export function Field({ label, htmlFor, children }: { label: string; htmlFor: string; children: ReactNode }) {
  return (
    <div>
      <UiLabel htmlFor={htmlFor} className="text-sm font-medium">
        {label}
      </UiLabel>
      <div className="mt-1.5">{children}</div>
    </div>
  )
}

export function ColorRow({ value, onChange }: { value: string; onChange: (next: string) => void }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      {PRESET_COLORS.map((preset) => {
        const selected = value.toLowerCase() === preset.toLowerCase()
        return (
          <button
            key={preset}
            type="button"
            onClick={() => onChange(preset)}
            className={cn(
              "h-8 w-8 rounded-full border-2 transition-transform",
              selected ? "scale-110 border-foreground" : "border-transparent hover:scale-105"
            )}
            style={{ backgroundColor: preset }}
            aria-label={`Pick color ${preset}`}
            aria-pressed={selected}
          />
        )
      })}
      <label className="ml-1 inline-flex items-center gap-1.5 rounded-full border bg-background px-2 py-1 text-xs font-medium text-muted-foreground">
        <input
          type="color"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="h-4 w-4 cursor-pointer rounded border-0 bg-transparent p-0"
          aria-label="Custom color"
        />
        <span className="font-mono tracking-tight">{value.toUpperCase()}</span>
      </label>
    </div>
  )
}

export function EmojiField({
  workspaceId,
  value,
  onChange,
}: {
  workspaceId: string
  value: string
  onChange: (next: string) => void
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <ReactionEmojiPicker
        workspaceId={workspaceId}
        onSelect={onChange}
        trigger={
          <button
            type="button"
            className="flex h-9 w-9 items-center justify-center rounded-lg border text-lg leading-none transition-colors hover:border-foreground/30"
            aria-label="Search emoji"
          >
            {value || <SmilePlus className="h-4 w-4 text-muted-foreground" />}
          </button>
        }
      />
      <div className="h-5 w-px bg-border" />
      {PRESET_EMOJIS.map((preset) => {
        const selected = value === preset
        return (
          <button
            key={preset}
            type="button"
            onClick={() => onChange(selected ? "" : preset)}
            className={cn(
              "h-9 w-9 rounded-full border text-lg leading-none transition-colors",
              selected ? "border-foreground bg-foreground/5" : "border-transparent bg-muted hover:border-border"
            )}
            aria-label={`Pick emoji ${preset}`}
            aria-pressed={selected}
          >
            {preset}
          </button>
        )
      })}
      {value && (
        <button
          type="button"
          onClick={() => onChange("")}
          className="inline-flex h-7 items-center gap-1 rounded-full px-2 text-xs text-muted-foreground hover:text-foreground"
        >
          <X className="h-3 w-3" />
          Clear
        </button>
      )}
    </div>
  )
}

/**
 * Edit a label's name, color, emoji, and description. Shared by the catalog
 * (rendered as a card flip, `variant="card"`) and the label landing page
 * (rendered inside a dialog, `variant="dialog"`) so both edit surfaces stay one
 * implementation. The card variant carries a left rail that tracks the live
 * color pick; the dialog variant is plain and lets the dialog provide chrome.
 */
export function LabelEditForm({
  workspaceId,
  label,
  onDone,
  variant = "card",
}: {
  workspaceId: string
  label: CachedLabel
  onDone: () => void
  variant?: "card" | "dialog"
}) {
  const [name, setName] = useState(label.name)
  const [color, setColor] = useState(label.color)
  const [emoji, setEmoji] = useState(label.emoji ?? "")
  const [description, setDescription] = useState(label.description ?? "")
  const updateMutation = useUpdateLabel(workspaceId)

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault()
    if (!name.trim()) return
    updateMutation.mutate(
      {
        labelId: label.id,
        input: {
          name: name.trim(),
          color,
          emoji: emoji.trim() || null,
          description: description.trim() || null,
        },
      },
      {
        onSuccess: () => {
          toast.success("Label updated")
          onDone()
        },
        onError: () => toast.error("Could not update label"),
      }
    )
  }

  return (
    <form
      onSubmit={handleSubmit}
      className={cn(
        "flex flex-col gap-3",
        variant === "card" && "relative overflow-hidden rounded-xl border bg-card p-3.5"
      )}
      style={variant === "card" ? { borderLeft: `3px solid ${color}` } : undefined}
    >
      <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name" autoFocus />
      <ColorRow value={color} onChange={setColor} />
      <EmojiField workspaceId={workspaceId} value={emoji} onChange={setEmoji} />
      <Textarea
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        placeholder="Description (optional)"
        rows={2}
      />
      <div className="flex justify-end gap-2">
        <Button type="button" size="sm" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={updateMutation.isPending || !name.trim()}>
          Save
        </Button>
      </div>
    </form>
  )
}
