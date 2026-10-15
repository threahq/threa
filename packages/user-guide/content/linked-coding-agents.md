---
title: Linking Claude Code, Pi or Hermes
summary: How to connect an agent running on your own machine to a Threa scratchpad, and what the connect page asks you to approve.
section: integrations
order: 6
---

# Linking Claude Code, Pi or Hermes

A linked agent keeps running on your machine, against your real files. Threa gives it a scratchpad, and messages you write there are handed to the local session. This is for advanced users, and the setup happens in a terminal.

## What a link is

The agent is a personal bot with the **Active scratchpad** trait. When it registers, Threa creates a scratchpad for it, and every message in that scratchpad becomes a turn for the local session. Replies and progress notes post back to the scratchpad. The agent pulls work from Threa, so the machine needs no inbound ports. See [Bots](/guide/bots-overview) for what a personal bot is.

## Connecting with a code

The `@threahq/bot` package wraps any command that reads a message on stdin and prints a reply on stdout:

```
npx @threahq/bot connect
npx @threahq/bot run -- my-agent
```

`connect` prints a URL and a code. Open it in a browser where you are signed in to Threa. It does not have to be the same machine, so this works over SSH. The code lasts 15 minutes and works once.

The approval page, headed "Connect" followed by the name the terminal asked for, asks for:

- A **Workspace** picker for the workspace the bot is created in.
- A **Bot name** field for the new personal bot.
- An optional **Let it read everything you can read** checkbox. When checked, the bot can read the streams you can read, except end-to-end encrypted ones. It still posts only where it has been added. You can change this later in the bot's settings.

Choose **Connect** to approve, or **Not me, deny** to turn the request down. On approval Threa creates the bot with the Mentionable and Active scratchpad traits and an API key, and the key goes to the machine that asked. It is saved in `~/.threa/bot.json` and never passes through your clipboard. To take access back, archive the bot or revoke its key (see [Bot API keys and webhooks](/guide/bot-api-keys-and-webhooks)).

`run` links a scratchpad for the directory you start it in and prints its URL. In that scratchpad, `/stop` stops the running command. A message you send while the command runs waits until it finishes.

## Claude Code, Pi and Hermes

Each of these has its own package, set up in the terminal from its README in the Threa repository:

- Claude Code: the `threa-channel` package, installed with `npm install -g @threahq/claude-code-remote`. It needs Claude Code 2.1.80 or later and a personal bot with the Active scratchpad trait.
- Pi: `pi install npm:@threahq/pi-remote`.
- Hermes: `npm install -g @threahq/hermes-remote`, started with `threa-hermes`. Its scratchpad also accepts `/stop`, `/status`, `/model` and `/clear`.

When Claude Code or Hermes needs permission to run a command, the request can appear in the scratchpad as a decision card that you answer there (see [Decision cards](/guide/decision-cards)). Claude Code's cards need a plaintext stream. An encrypted scratchpad works only after its owner invites the agent into it (see [Encrypted scratchpads](/guide/encrypted-scratchpads)).

## Messages while the agent is working

When Claude Code, Pi or Hermes is in the middle of a turn, a message you send in its scratchpad goes to the agent right away, and the agent reads it as part of the work in progress. If the agent can't take it at that moment, the message waits and starts the next turn.

To hold a message until the agent finishes its turn, put `/enqueue` in it, for example `/enqueue run the tests again`. `/enqueue` can go anywhere in the message, and the agent receives the message without it. `/enqueue` with nothing else sends nothing. It needs the agent connected, and it can't be combined with another command.

Protocol details, scopes and the other packages are on [threa.io/developers](https://threa.io/developers).
