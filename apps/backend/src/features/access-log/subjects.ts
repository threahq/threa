/**
 * Subjects are refs, never content (design §5): entity refs `{type, id}`, range
 * refs (stream sequence or sync-log spans), and coarse refs. Arrays are capped
 * with an explicit overflow tail so a truncated list never reads as complete
 * coverage.
 */

import type { Response } from "express"

export interface AuditSubjectRef {
  type: string
  id?: string
  fromSeq?: number
  toSeq?: number
  fromSync?: string
  toSync?: string
  /** Only on the synthetic overflow tail. */
  count?: number
}

export const SUBJECTS_CAP = 100
// Real subject ids are prefixed ULIDs, room segments, or sync cursors — all
// id-charset. Anything else (a probed route param carrying an email or free
// text) is redacted: the no-content rule beats forensic curiosity about the
// exact garbage an attacker probed with.
const REF_ID_SHAPE = /^[A-Za-z0-9:._-]{1,256}$/
const REF_TYPE_SHAPE = /^[a-z_]{1,64}$/

/**
 * Cap a subjects array at `SUBJECTS_CAP`, appending `{type:'overflow', count}`
 * when refs were dropped. `count` is the number omitted. Ref strings are also
 * shape-enforced: subjects must stay id-shaped, never a smuggling channel for
 * free text into the content-free log (design §5).
 */
export function capSubjects(refs: AuditSubjectRef[]): AuditSubjectRef[] {
  const clamped = refs.map((ref) => {
    const typeOk = REF_TYPE_SHAPE.test(ref.type)
    const idOk = ref.id === undefined || REF_ID_SHAPE.test(ref.id)
    if (typeOk && idOk) return ref
    return { ...ref, type: typeOk ? ref.type : "invalid", id: ref.id === undefined || idOk ? ref.id : "#redacted" }
  })
  if (clamped.length <= SUBJECTS_CAP) return clamped
  // Reserve one slot for the overflow marker so the result never exceeds
  // SUBJECTS_CAP; `count` includes the displaced ref omitted to make room.
  const keptCount = SUBJECTS_CAP - 1
  const kept = clamped.slice(0, keptCount)
  kept.push({ type: "overflow", count: clamped.length - keptCount })
  return kept
}

export interface AuditDenial {
  status: 403 | 404
  subject: AuditSubjectRef
}

const AUDIT_SUBJECTS_KEY = "auditSubjects"
const AUDIT_DENIALS_KEY = "auditDenials"

// A 2xx batch can refuse individual results. Only delivered refs belong to
// the successful request row; refusals need their own denial outcomes.
export function setAuditSubjects(res: Response, refs: AuditSubjectRef[], denials: AuditDenial[] = []): void {
  res.locals[AUDIT_SUBJECTS_KEY] = refs
  res.locals[AUDIT_DENIALS_KEY] = denials
}

/** Read the audit subjects a handler populated, if any. */
export function readAuditSubjects(res: Response): AuditSubjectRef[] | undefined {
  return res.locals[AUDIT_SUBJECTS_KEY] as AuditSubjectRef[] | undefined
}

export function readAuditDenials(res: Response): AuditDenial[] {
  return (res.locals[AUDIT_DENIALS_KEY] as AuditDenial[] | undefined) ?? []
}
