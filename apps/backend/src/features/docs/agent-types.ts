/**
 * Why an agent's doc write resolved nothing. `scope.markdown` is the current
 * marker-annotated markdown of the named block, or of the whole doc when the
 * edit named none, so the agent can retry with a tighter anchor.
 */
export interface DocAgentEditRefusal {
  reason: "not_found" | "ambiguous" | "unknown_block"
  /** The failing entry of an `edit_doc` call. */
  editIndex?: number
  scope: { blockId?: string; markdown: string }
}

export type DocAgentRefusalCode =
  | "not_a_member"
  | "read_only"
  | "archived"
  | "host_cannot_host_docs"
  | "e2e_host"
  | "title_empty"
  | "forbidden"

/** An agent op on a doc it cannot reach, or a write its invoking user may not make. `detail` carries an unmapped error code. */
export type DocAgentAccessRefusal =
  | { status: "not_found" }
  | { status: "refused"; code: DocAgentRefusalCode; detail?: string }

/** `markdown` is the changed blocks, marker-annotated. */
export type DocAgentWriteResult =
  | {
      status: "applied"
      docId: string
      title: string | null
      seq: number
      touchedBlockIds: string[]
      markdown: string
    }
  | { status: "unchanged"; docId: string; title: string | null; seq: number }
  | { status: "edit_refused"; refusal: DocAgentEditRefusal }
  | { status: "invalid" }
  | DocAgentAccessRefusal

/** A write that left the doc as it was; `error` is a failure already logged. */
export type DocAgentRewriteFailure =
  | Exclude<DocAgentWriteResult, { status: "applied" | "unchanged" }>
  | { status: "error" }

export interface DocAgentDocSummary {
  docId: string
  title: string | null
}

/** `markdown` is the whole doc, marker-annotated. */
export type DocAgentReadResult =
  | { status: "ok"; docId: string; title: string | null; seq: number; markdown: string }
  | { status: "not_found" }

export type DocAgentTitleResult = { status: "applied"; docId: string; title: string } | DocAgentAccessRefusal

/**
 * Once the doc row exists every outcome is `created` with its id. `body` is set
 * only when a requested body was not applied; `titleFailure` only when a
 * requested title was not set.
 */
export type DocAgentCreateResult =
  | {
      status: "created"
      docId: string
      title: string | null
      seq: number
      markdown: string
      body?: DocAgentRewriteFailure
      titleFailure?: DocAgentAccessRefusal | { status: "error" }
    }
  | DocAgentAccessRefusal
