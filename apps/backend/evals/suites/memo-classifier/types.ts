/**
 * Memo Classifier Evaluation Types
 */

export interface EvalClassifierMessage {
  /** Stable id rendered in the prompt; generated when omitted. */
  id?: string
  authorId: string
  authorType: "user" | "persona"
  authorName: string
  contentMarkdown: string
  /** Minutes before "now" this message was sent. Defaults to spacing 2min apart. */
  minutesAgo?: number
}

export interface EvalExistingMemo {
  title: string
  abstract: string
  /** Age of the memo; defaults to 1 day. */
  createdDaysAgo?: number
}

export interface MemoClassifierInput {
  /** Conversation topic title, as boundary extraction would have set it. */
  topicSummary: string | null
  messages: EvalClassifierMessage[]
  /** Active memos already sourced from this conversation (revision path). */
  existingMemos?: EvalExistingMemo[]
  category?: "chatter" | "news-reactions" | "logistics" | "knowledge" | "mixed" | "revision" | "transient"
}

export interface MemoClassifierOutput {
  input: MemoClassifierInput
  isKnowledgeWorthy: boolean
  shouldReviseExisting: boolean
  confidence: number
  containsActionItems: boolean
  error?: string
}

export interface MemoClassifierExpected {
  expectKnowledgeWorthy: boolean
  /** Only asserted when the case provides existingMemos. */
  expectReviseExisting?: boolean
}
