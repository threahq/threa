import { useEffect, useState } from "react"

const ROLL_MS = 300

interface Roll {
  id: number
  from: string
  up: boolean
}

interface RollingNumberProps {
  value: number
  format?: (value: number) => string
}

/**
 * A counter that rolls its old text out and the new text in when the value
 * changes. A count leaving zero appears in place: a roll only reads as a change
 * when there was something to change from. Settled, it is bare text, so it
 * reads as part of the label around it; style it from the parent.
 */
export function RollingNumber({ value, format = String }: RollingNumberProps) {
  const text = format(value)
  const [shown, setShown] = useState({ value, text })
  const [roll, setRoll] = useState<Roll | null>(null)

  if (text !== shown.text) {
    setShown({ value, text })
    setRoll(shown.value === 0 ? null : { id: (roll?.id ?? 0) + 1, from: shown.text, up: value > shown.value })
  }

  useEffect(() => {
    if (!roll) return
    const timeout = window.setTimeout(() => setRoll(null), ROLL_MS)
    return () => window.clearTimeout(timeout)
  }, [roll])

  if (!roll) return text

  return (
    <span className="rolling-number" data-direction={roll.up ? "up" : "down"}>
      <span key={`out-${roll.id}`} className="rolling-number-out" data-text={roll.from} aria-hidden="true" />
      <span key={`in-${roll.id}`} className="rolling-number-in">
        {text}
      </span>
    </span>
  )
}
