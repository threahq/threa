import { AuthorTypes, type BridgeMessage } from "@threahq/types"

interface NamedAuthors {
  userIds: Set<string>
  personaIds: Set<string>
  botIds: Set<string>
}

/** The users, personas and bots the messages name as author or reactor. */
export function namedAuthors(
  messages: Iterable<Pick<BridgeMessage, "authorId" | "authorType" | "reactions">>
): NamedAuthors {
  const named: NamedAuthors = { userIds: new Set(), personaIds: new Set(), botIds: new Set() }
  const addReactor = (id: string) => {
    if (id.startsWith("usr_")) named.userIds.add(id)
    else if (id.startsWith("persona_")) named.personaIds.add(id)
    else if (id.startsWith("bot_")) named.botIds.add(id)
  }
  for (const message of messages) {
    if (message.authorType === AuthorTypes.USER) named.userIds.add(message.authorId)
    if (message.authorType === AuthorTypes.PERSONA) named.personaIds.add(message.authorId)
    if (message.authorType === AuthorTypes.BOT) named.botIds.add(message.authorId)
    for (const reactors of Object.values(message.reactions)) reactors.forEach(addReactor)
  }
  return named
}
