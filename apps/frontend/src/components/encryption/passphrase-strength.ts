/**
 * Lightweight passphrase scoring for the setup modal. Not a substitute for a
 * real strength estimator like zxcvbn — this is a directional signal so users
 * can see whether their passphrase clears the "obviously weak" bar. The KDF
 * cost (Argon2id) is what actually protects the bundle; this just nudges
 * users toward something they won't regret.
 */

export type PassphraseScoreLevel = 0 | 1 | 2 | 3 | 4

export interface PassphraseScore {
  level: PassphraseScoreLevel
  label: string
  description: string
}

const LABELS: Record<PassphraseScoreLevel, { label: string; description: string }> = {
  0: { label: "Very weak", description: "Use at least 10 characters." },
  1: { label: "Weak", description: "Mix in upper/lower-case, numbers, or symbols." },
  2: { label: "Fair", description: "Adding length or another character class would help." },
  3: { label: "Good", description: "Solid — a memorable sentence is better than a short random string." },
  4: { label: "Strong", description: "Long and varied. Make sure you can recall it later." },
}

export function scorePassphrase(passphrase: string): PassphraseScore {
  const length = passphrase.length
  if (length === 0) return { level: 0, ...LABELS[0] }

  const classes =
    (/[a-z]/.test(passphrase) ? 1 : 0) +
    (/[A-Z]/.test(passphrase) ? 1 : 0) +
    (/\d/.test(passphrase) ? 1 : 0) +
    (/[^A-Za-z0-9]/.test(passphrase) ? 1 : 0)

  // Length buckets, then nudge up for character-class diversity. The cap at
  // 4 keeps the visual scale stable even for very long passphrases.
  let level: PassphraseScoreLevel = 0
  if (length >= 10) level = 1
  if (length >= 14) level = 2
  if (length >= 18) level = 3
  if (length >= 24) level = 4
  if (classes >= 3 && level < 4) level = (level + 1) as PassphraseScoreLevel
  if (classes <= 1 && level > 1) level = (level - 1) as PassphraseScoreLevel

  return { level, ...LABELS[level] }
}
