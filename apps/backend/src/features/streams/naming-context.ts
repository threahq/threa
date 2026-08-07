import type { Querier } from "../../db"
import { findThreadAnchorContext, serializeThreadAnchorCard } from "../agents"
import type { Message } from "../messaging"
import type { Stream } from "./repository"

export const renderNamingEventAnchor = serializeThreadAnchorCard

export async function prependThreadNamingAnchor(db: Querier, stream: Stream, replies: Message[]): Promise<Message[]> {
  const anchor = await findThreadAnchorContext(db, stream)
  return anchor ? [anchor, ...replies.filter((message) => message.id !== anchor.id)] : replies
}
