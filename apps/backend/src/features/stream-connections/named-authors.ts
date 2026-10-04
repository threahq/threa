import type { BridgeMessage } from "@threahq/types"

interface NamedAuthors {
  userIds: Set<string>
  personaIds: Set<string>
  botIds: Set<string>
}

/**
 * The users, personas and bots the messages name as author or reactor. Bucketed
 * by id prefix, never by `authorType`, so a mistyped author still meets its check.
 */
export function namedAuthors(messages: Iterable<Pick<BridgeMessage, "authorId" | "reactions">>): NamedAuthors {
  const named: NamedAuthors = { userIds: new Set(), personaIds: new Set(), botIds: new Set() }
  const add = (id: string) => {
    if (id.startsWith("usr_")) named.userIds.add(id)
    else if (id.startsWith("persona_")) named.personaIds.add(id)
    else if (id.startsWith("bot_")) named.botIds.add(id)
  }
  for (const message of messages) {
    add(message.authorId)
    for (const reactors of Object.values(message.reactions)) reactors.forEach(add)
  }
  return named
}
