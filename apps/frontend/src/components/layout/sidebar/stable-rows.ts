import { shareById } from "@/lib/structural-sharing"
import type { ResolvedSection } from "./resolve-sections"

export function shareSections(prev: readonly ResolvedSection[], next: readonly ResolvedSection[]): ResolvedSection[] {
  const prevById = new Map(prev.map((entry) => [entry.section.id, entry]))
  let same = prev.length === next.length
  const shared = next.map((entry, index) => {
    const before = prevById.get(entry.section.id)
    let kept = entry
    if (before) {
      const items = shareById(before.items, entry.items)
      kept = before.section === entry.section && items === before.items ? before : { section: entry.section, items }
    }
    if (kept !== prev[index]) same = false
    return kept
  })
  return same ? (prev as ResolvedSection[]) : shared
}
