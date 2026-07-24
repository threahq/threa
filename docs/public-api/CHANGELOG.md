# Threa Public API changelog

Generated from the version-change modules. Do not edit by hand.

## 2026-07-24

Message responses now include a top-level `slots` map hydrating cross-stream shared-message pointers (keyed `shared:<messageId>`, markdown content only). Pins before this version have the map stripped.

Affected operations: completeBotInvocation, findMessagesByMetadata, listConversationMessages, listMessages, searchMessages, sendMessage, updateMessage

## 2026-07-22

Threads can now anchor on cards: stream `parentMessageId` became `anchorId`, and current-version delegation completions put results directly in the card thread while 2026-07-12 retains its synthetic message anchor.

Affected operations: completeDelegation, getStream, listStreams, updateStream

## 2026-07-12

Initial versioned API.
