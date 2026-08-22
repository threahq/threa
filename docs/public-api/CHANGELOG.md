# Threa Public API changelog

Generated from the version-change modules. Do not edit by hand.

## 2026-08-21

Shared-message and quote references pin a source revision and optional span. `slots` keys carry the reference (`shared:<messageId>[@<version>[:<from>-<to>]]`), `ok` slots gain `version`, `currentRevision` and `range`, and `content` is the revision the reference names rather than the source as it now reads. Pins before this version still get one `shared:<messageId>` key per source, the whole-message slot at the highest version, without the pin fields; a reference to a span of a message is omitted for those pins, since that shape cannot say it is a fragment.

Affected operations: completeBotInvocation, findMessagesByMetadata, listConversationMessages, listMessages, searchMessages, sendMessage, updateMessage

## 2026-07-24

Message responses now include a top-level `slots` map hydrating cross-stream shared-message pointers (keyed `shared:<messageId>`, markdown content only). Pins before this version have the map stripped.

Affected operations: completeBotInvocation, findMessagesByMetadata, listConversationMessages, listMessages, searchMessages, sendMessage, updateMessage

## 2026-07-22

Threads can now anchor on cards: stream `parentMessageId` became `anchorId`, and current-version delegation completions put results directly in the card thread while 2026-07-12 retains its synthetic message anchor.

Affected operations: completeDelegation, getStream, listStreams, updateStream

## 2026-07-12

Initial versioned API.
