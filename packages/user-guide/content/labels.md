---
title: Labels
summary: Create private labels with a colour and an emoji, apply them to streams and messages, and find everything carrying a label on its own page.
section: conversations
order: 12
---

# Labels

Labels group the things you want to keep together, such as a project, a reading list or a topic. Each label has a name, a colour and an optional emoji and description. Labels belong to you alone, so nobody else sees yours or what you applied them to.

## Create and manage labels

Open the [Labels](app:labels) page from **Labels** in the sidebar's Quick Links. Select **Add label** to open the dialog:

- **Name**, up to 80 characters.
- **Color**, from ten presets or a custom colour picker.
- **Emoji**, from a search picker or twelve preset emojis. It is optional, and a label without one shows a tag icon.
- **Description**, up to 280 characters and optional.

Each label card on the page has **Edit** and **Delete**. Deleting asks for confirmation, archives the label and removes it from everything it was applied to. This cannot be undone. Creating, editing and deleting need a connection, so they are disabled while you are offline.

## Apply a label

Applying works on streams (scratchpads, channels, DMs and threads) and on single messages.

- For a stream, choose **Labels…** from its menu in the sidebar, from the stream's actions menu, or run **Labels…** from the [quick switcher](/guide/quick-switcher-and-command-palette) while the stream is open.
- For a message, choose **Label message** from the message's actions.

Both open a picker titled **Labels**. It has a search box ("Search labels…") and a checkbox per label. Ticking applies the label and unticking removes it, and the picker stays open so you can change several in one go. If you have no labels yet, the picker links to the Labels page.

A labeled stream shows its labels as a small stack of glyphs in its header. Hover over the stack, or tap it on a touch device, to see the label names. Each name opens that label's page. Labeled messages show the same stack next to the message.

## A label's page

Select a label card, or one of those names, to open its page at `labels/<id>`. It shows the label's colour, emoji, description and counts, then two lists:

- **Streams** lists the streams carrying the label.
- **Messages** lists the labeled messages, each with the stream it came from.

The **Edit** button on the page changes the name, colour, emoji and description.

## Labels in the sidebar

A labeled stream shows its first label's mark at the right of its sidebar row, with "+N" when it has more than one label. The mark is the label's emoji, or a coloured dot if it has none. You can also turn a label into a sidebar section that lists every stream carrying it. A stream that carries a label shown as a section appears under that section instead of in its usual group. See [Customizing the sidebar](/guide/customize-your-sidebar).

Labels are also a filter on the [board](/guide/board), which offers a Labels picker once you have at least one label.
