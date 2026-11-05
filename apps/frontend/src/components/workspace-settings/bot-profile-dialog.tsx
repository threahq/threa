import { useId, useState } from "react"
import type { BotTrait } from "@threahq/types"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import {
  ResponsiveDialog,
  ResponsiveDialogBody,
  ResponsiveDialogContent,
  ResponsiveDialogFooter,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from "@/components/ui/responsive-dialog"
import { SETTING_CONTROL_HEIGHT, SettingFieldError } from "@/components/settings/setting-primitives"
import { SETTING_MUTED_NOTE_TEXT } from "@/components/settings/setting-text"
import { BotTraitsPicker } from "./bot-traits-picker"

export interface BotProfileValues {
  name: string
  slug: string
  description: string | null
  traits: BotTrait[]
}

interface BotProfileDialogProps {
  open: boolean
  onClose: () => void
  /** `create` derives the slug from the name until the slug is edited. */
  mode: "create" | "edit"
  initial?: BotProfileValues
  namePlaceholder?: string
  isPending: boolean
  error: Error | null
  onSubmit: (values: BotProfileValues) => void
}

/** Create a bot or edit its profile: name, slug, description and capabilities. */
export function BotProfileDialog({ open, onClose, isPending, ...form }: BotProfileDialogProps) {
  return (
    <ResponsiveDialog
      open={open}
      onOpenChange={(next) => !next && !isPending && onClose()}
      disableSnapPoints
      historyEntry={false}
    >
      <ResponsiveDialogContent desktopClassName="max-w-md" drawerClassName="max-h-[92dvh]">
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>{form.mode === "create" ? "New bot" : "Edit profile"}</ResponsiveDialogTitle>
        </ResponsiveDialogHeader>
        {open && <BotProfileForm {...form} isPending={isPending} onClose={onClose} />}
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  )
}

const SUBMIT_LABELS = {
  create: { idle: "Create bot", pending: "Creating…" },
  edit: { idle: "Save", pending: "Saving…" },
} as const

function slugFromName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
}

function BotProfileForm({
  mode,
  initial,
  namePlaceholder,
  isPending,
  error,
  onSubmit,
  onClose,
}: Omit<BotProfileDialogProps, "open">) {
  const ids = { name: useId(), slug: useId(), slugHint: useId(), description: useId() }
  const [name, setName] = useState(initial?.name ?? "")
  const [slug, setSlug] = useState(initial?.slug ?? "")
  const [slugTouched, setSlugTouched] = useState(mode === "edit")
  const [description, setDescription] = useState(initial?.description ?? "")
  const [traits, setTraits] = useState<Set<BotTrait>>(() => new Set(initial?.traits))

  const canSubmit = name.trim().length > 0 && slug.trim().length > 0 && !isPending

  const submit = () => {
    if (!canSubmit) return
    onSubmit({
      name: name.trim(),
      slug: slug.trim(),
      description: description.trim() || null,
      traits: Array.from(traits),
    })
  }

  return (
    <div
      className="flex min-h-0 flex-1 flex-col"
      onKeyDown={(e) => {
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit()
      }}
    >
      <ResponsiveDialogBody className="min-h-0 space-y-5">
        <div className="space-y-2">
          <Label htmlFor={ids.name}>Name</Label>
          <Input
            id={ids.name}
            placeholder={namePlaceholder}
            value={name}
            disabled={isPending}
            className={SETTING_CONTROL_HEIGHT}
            onChange={(e) => {
              setName(e.target.value)
              if (!slugTouched) setSlug(slugFromName(e.target.value))
            }}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor={ids.slug}>Slug</Label>
          <Input
            id={ids.slug}
            placeholder="my-bot"
            aria-describedby={ids.slugHint}
            value={slug}
            disabled={isPending}
            className={SETTING_CONTROL_HEIGHT}
            onChange={(e) => {
              setSlugTouched(true)
              setSlug(e.target.value)
            }}
          />
          <p id={ids.slugHint} className={SETTING_MUTED_NOTE_TEXT}>
            Lowercase letters, numbers and hyphens. People mention the bot as @slug.
          </p>
        </div>
        <div className="space-y-2">
          <Label htmlFor={ids.description}>
            Description <span className="font-normal text-muted-foreground">(optional)</span>
          </Label>
          <Textarea
            id={ids.description}
            placeholder="What does this bot do?"
            value={description}
            disabled={isPending}
            onChange={(e) => setDescription(e.target.value)}
            rows={2}
          />
        </div>
        <BotTraitsPicker
          traits={traits}
          disabled={isPending}
          onChange={(trait, checked) =>
            setTraits((current) => {
              const next = new Set(current)
              if (checked) next.add(trait)
              else next.delete(trait)
              return next
            })
          }
        />
        {error && (
          <SettingFieldError>
            {error.message || (mode === "create" ? "Couldn't create the bot." : "Couldn't save the profile.")}
          </SettingFieldError>
        )}
      </ResponsiveDialogBody>
      <ResponsiveDialogFooter>
        <Button variant="outline" onClick={onClose} disabled={isPending}>
          Cancel
        </Button>
        <Button onClick={submit} disabled={!canSubmit}>
          {isPending ? SUBMIT_LABELS[mode].pending : SUBMIT_LABELS[mode].idle}
        </Button>
      </ResponsiveDialogFooter>
    </div>
  )
}
