---
title: Answering agent questions
summary: What a decision card is, who can answer it, and what happens when you pick an option.
section: agents
order: 9
---

# Answering agent questions

A decision card is a question a bot asks you in a conversation when it reaches a call that only a person can make. It offers options to pick from and, sometimes, a place for a note.

## What a card looks like

The header reads the bot's name followed by **needs a decision** while the card is open. The card shows a title, an optional body and up to 8 option buttons. Some cards also have an **Add a note** field.

Click an option to answer. The card then shows which option was chosen, who chose it and when, together with the note. After it is answered, the header reads the bot's name followed by **asked for a decision**.

## Who can answer

- Anyone who can read the stream can answer.
- The first answer wins. If someone else answered first, a notice says **This decision was already answered** and the card shows their answer.
- A card from a personal bot can only be answered by the bot's owner.

## Cancelled and expired cards

The bot can withdraw a card, and it can give a card a deadline of up to 24 hours. A card then shows **Cancelled** or **Expired** and can't be answered.

## Encrypted scratchpads

In an encrypted scratchpad the card is sealed, along with its note. Unlock the scratchpad to read and answer it. See [Encrypted scratchpads](/guide/encrypted-scratchpads).

## Discussing a card

A thread can be opened under a card to discuss it (see [Threads](/guide/threads)).

## Where they come from

A bot opens a decision card through the Threa API using a bot key. A personal API key can't open one. For bots in general see [Bots overview](/guide/bots-overview), and for the API see [threa.io/developers](https://threa.io/developers).
