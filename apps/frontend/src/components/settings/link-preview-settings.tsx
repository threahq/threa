import { useEffect, useState } from "react"
import { LINK_PREVIEW_CATEGORIES, DEFAULT_LINK_PREVIEW_OPEN_COUNT, type LinkPreviewLimit } from "@threahq/types"
import { usePreferences } from "@/contexts"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"

const CATEGORY_LABELS = {
  image: "Images",
  video: "Videos",
  github: "GitHub",
  linear: "Linear",
  website: "Websites",
  pdf: "PDFs",
}

function LimitControl({
  id,
  label,
  value,
  disabled,
  onSave,
  inheritable = false,
}: {
  id: string
  label: string
  value: LinkPreviewLimit | undefined
  disabled: boolean
  onSave: (value: LinkPreviewLimit | undefined) => void
  inheritable?: boolean
}) {
  const [draft, setDraft] = useState(typeof value === "number" ? String(value) : "0")
  const [invalid, setInvalid] = useState(false)
  useEffect(() => {
    if (typeof value === "number") setDraft(String(value))
    setInvalid(false)
  }, [value])
  const mode = typeof value === "number" ? "count" : (value ?? "default")
  function commit() {
    const count = Number(draft)
    const valid = draft.trim() !== "" && Number.isSafeInteger(count) && count >= 0
    setInvalid(!valid)
    if (valid && count !== value) onSave(count)
  }
  return (
    <div className="grid gap-2 sm:grid-cols-[1fr_auto] sm:items-start">
      <Label htmlFor={id} className="pt-2">
        {label}
      </Label>
      <div className="flex flex-wrap gap-2">
        <Select
          value={mode}
          disabled={disabled}
          onValueChange={(next) => {
            setInvalid(false)
            if (next === "default") onSave(undefined)
            else if (next === "all") onSave("all")
            else {
              const count = Number(draft)
              onSave(Number.isSafeInteger(count) && count > 0 ? count : DEFAULT_LINK_PREVIEW_OPEN_COUNT)
            }
          }}
        >
          <SelectTrigger id={id} className="w-36" aria-label={`${label} expansion`}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {inheritable && <SelectItem value="default">Use default</SelectItem>}
            <SelectItem value="count">Expand</SelectItem>
            <SelectItem value="all">Expand all</SelectItem>
          </SelectContent>
        </Select>
        {mode === "count" && (
          <Input
            aria-label={`${label} count`}
            type="number"
            inputMode="numeric"
            min={0}
            step={1}
            className="w-24"
            value={draft}
            disabled={disabled}
            aria-invalid={invalid}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={commit}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault()
                commit()
              }
            }}
          />
        )}
        {invalid && (
          <p role="alert" className="basis-full text-sm text-destructive">
            Enter a whole number of 0 or more.
          </p>
        )}
      </div>
    </div>
  )
}

export function LinkPreviewSettings() {
  const { preferences, updatePreferences, isLoading } = usePreferences()
  const count = preferences?.linkPreviewOpenCount ?? DEFAULT_LINK_PREVIEW_OPEN_COUNT
  const globalLimit = preferences?.linkPreviewDefault === "collapsed" ? 0 : count
  const overrides = preferences?.linkPreviewTypeOverrides ?? {}
  async function save(input: Parameters<typeof updatePreferences>[0]) {
    try {
      await updatePreferences(input)
    } catch {
      /* The provider reports save failures. */
    }
  }
  return (
    <section className="space-y-3">
      <div>
        <h3 className="text-sm font-medium">Link previews</h3>
        <p className="text-sm text-muted-foreground">
          Counts restart for each message. Types using the default share its count. Each override counts separately.
        </p>
        <p className="text-sm text-muted-foreground">
          Use 0 to collapse previews. Your manual expand and collapse choices take precedence.
        </p>
      </div>
      <LimitControl
        id="link-preview-default"
        label="Default"
        value={globalLimit}
        disabled={isLoading}
        onSave={(value) => {
          if (value === undefined) return
          void save(
            value === 0
              ? { linkPreviewDefault: "collapsed" }
              : { linkPreviewDefault: "open", linkPreviewOpenCount: value }
          )
        }}
      />
      {LINK_PREVIEW_CATEGORIES.map((category) => (
        <LimitControl
          key={category}
          id={`link-preview-${category}`}
          label={CATEGORY_LABELS[category]}
          value={overrides[category]}
          disabled={isLoading}
          inheritable
          onSave={(value) => {
            const next = { ...overrides }
            if (value === undefined) delete next[category]
            else next[category] = value
            void save({ linkPreviewTypeOverrides: next })
          }}
        />
      ))}
    </section>
  )
}
