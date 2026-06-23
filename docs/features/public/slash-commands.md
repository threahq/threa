---
title: Slash Commands
status: shipped
audience: public
since: 2026-05
surfaces: [composer, command-palette]
public_site: true
summary: >
  Type "/" in the composer to run a command: a workspace command like /invite, a
  local action like /discuss-with-ariadne, or a session control routed to a linked
  bot runtime, with an argument popover for commands whose options the runtime
  advertises.
related: [public/message-composer.md, public/ai-companions.md]
---

## What it does

Typing `/` in the composer opens a command palette. Which commands appear depends on where
you are, because commands come in a few kinds:

- **Workspace commands** run on the backend. Today this is `/invite`, which adds people or
  bots to a channel.
- **Local actions** run in the client without a backend round trip. Today this is
  `/discuss-with-ariadne`, which starts a discussion with the assistant about a message.
- **Bot-runtime commands** are routed to a bot runtime linked to the current stream. These
  are the Pi session controls (`compact`, `model`, `thinking`, `skill`, `reload`, `shell`,
  `steer`, `stop`), and they only appear when a Pi-local runtime is linked to the stream and
  advertises that it supports them.

The palette also offers three editor shortcuts that are not really commands at all (`/memo`,
`/giphy`, `/snippet`); selecting one opens the matching picker or editor instead of sending
anything to the backend.

When you pick a real command, it becomes an inline chip in the message (rendered as `/name`),
and on submit the composer routes it: a local action runs in place, anything else is
dispatched to the backend, which resolves it against the set of commands valid for that
stream and runs it (a workspace command through a worker, a bot-runtime command as a targeted
invocation to the linked runtime).

## How a user experiences it

### The palette

`/` opens the palette mid-sentence or at the start of a line; it is suppressed inside code.
Commands meant to be the whole message (like `/invite`) only surface when the slash is the
only thing in the message, while the inline editor shortcuts surface anywhere. Selecting a
command inserts its chip and a trailing space.

### Picking an argument

Some commands take an argument from a fixed set, and rather than make you type it, the
composer opens an argument popover right after the chip. In practice this is `/model` (the
model list) and `/thinking` (the levels); the options come from what the linked runtime
advertises it supports. The popover anchors to a fixed spot just after the command, so it
stays put as you type and filter, and picking an option drops the value in for you.

### Pasting text that starts with a slash

Pasted text that happens to start with `/` (a file path like `/Users/you/project`, say) is
not treated as a command. A command is only recognized when the slash word is followed by
whitespace or the end of the token and the name matches a command the composer knows about,
so a path stays plain text.

## Boundaries

- **There is one real workspace command.** `/invite` is the only command registered to run on
  the backend today.
- **Session controls depend on a linked runtime.** The Pi commands appear and work only when a
  Pi-local runtime is linked to the stream and advertises them; they are not available
  otherwise.
- **The editor shortcuts never reach the backend.** `/memo`, `/giphy` and `/snippet` are
  discovery shortcuts for composer features; they insert no chip and dispatch nothing.
- **Argument autocomplete is only for advertised options.** A command argument gets the popover
  only when the runtime advertises a list for it; other arguments are typed freehand.

## Related

- [Message composer](message-composer.md): the `/` palette is one of the composer's triggers.
- [AI companions](ai-companions.md): `/discuss-with-ariadne` and the bot-runtime session
  controls act on the assistant and on linked runtimes.
