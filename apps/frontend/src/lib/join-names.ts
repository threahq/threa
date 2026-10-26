/** "A", "A and B", "A, B and C"; past `maxNamed` (at least 3), "A, B and N others". */
export function joinNames(names: string[], maxNamed = Infinity): string {
  if (names.length > maxNamed) return joinNames([...names.slice(0, 2), `${names.length - 2} others`])
  if (names.length <= 1) return names[0] ?? ""
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`
}
