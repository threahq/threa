export function formatLocalTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false })
}

export function formatDuration(ms: number): string {
  const totalMin = Math.round(ms / 60_000)
  if (totalMin < 1) return "<1 min"
  if (totalMin < 60) return `${totalMin} min`
  const hours = Math.floor(totalMin / 60)
  const minutes = totalMin % 60
  return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`
}
