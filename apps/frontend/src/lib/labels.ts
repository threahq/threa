/**
 * Label presentation helpers shared across the catalog page, the assign picker,
 * and (later) the chip surfaces. Labels store an authored hex `color`; UIs tint
 * a swatch background from it while keeping the hex for the glyph foreground.
 */
export function hexToRgba(hex: string, alpha: number): string {
  const normalized = hex.replace("#", "")
  if (normalized.length !== 6) return hex
  const r = parseInt(normalized.slice(0, 2), 16)
  const g = parseInt(normalized.slice(2, 4), 16)
  const b = parseInt(normalized.slice(4, 6), 16)
  if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) return hex
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}
