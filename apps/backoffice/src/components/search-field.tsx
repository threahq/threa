import { Search } from "lucide-react"
import { Input } from "@/components/ui/input"

export function SearchField({
  value,
  onChange,
  placeholder,
  count,
}: {
  value: string
  onChange: (value: string) => void
  placeholder: string
  count: string
}) {
  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
      <div className="relative w-full sm:max-w-sm">
        <Search
          aria-hidden
          className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
        />
        <Input
          type="search"
          aria-label={placeholder}
          placeholder={placeholder}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="pl-9"
        />
      </div>
      <span className="text-sm tabular-nums text-muted-foreground">{count}</span>
    </div>
  )
}
