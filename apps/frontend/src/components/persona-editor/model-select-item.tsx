import type { PersonaModelOption } from "@threahq/types"
import { SelectItem } from "@/components/ui/select"

export function ModelSelectItem({ option }: { option: PersonaModelOption }) {
  return (
    <SelectItem value={option.id}>
      {option.label}
      {option.singleRegion && <span className="text-muted-foreground"> · can only run in one region</span>}
    </SelectItem>
  )
}
