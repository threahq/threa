---
title: Searching Threa
summary: Search every message you can access, search inside one conversation, and read the results.
section: search
order: 1
---

# Searching Threa

Search finds messages across the streams you can open, and a second search looks inside the conversation you're reading. Both update as you type.

## Search the workspace

Press Ctrl+Shift+F (⌘⇧F on Mac), or choose **Search messages** in the command palette. On a wide screen this opens a **Search** panel in the sidebar. On a phone it opens the full [Search](app:search) page. Both take the same queries and filters.

Search matches the words you type and also messages with a similar meaning, so an exact phrase isn't required. Results appear after a short pause in typing. The count shows as "N results", and the sidebar panel adds how many streams they come from.

What search covers:

- Streams you are a member of, public channels, and threads under a stream you can open.
- Archived streams as well as active ones, unless you add a status filter.
- Not end-to-end encrypted streams. The server can't read them, so they never appear in workspace search.

To narrow a query, see [Search filters](/guide/search-filters). The filter button, **Add filter**, sits under the search box.

## Use the results

In the sidebar panel, move through results with the arrow keys, press Enter to open the highlighted one, and press Esc to close the panel. Each result opens the message in its stream.

The **Grouped** and **Ranked** buttons change how results are laid out. Grouped is the default and puts results under a header for each stream, which you can collapse. Ranked shows one list in rank order, with each row naming its stream. Threa remembers the choice per workspace in your browser. On a phone, each conversation's matches are folded behind a count.

**Search memory**, next to the Grouped and Ranked buttons once you have typed words, runs those words against the [Memory](app:memory) page, which holds the knowledge Threa has extracted from conversations. See [The Memory page](/guide/memory-page).

## Search inside one conversation

Press Ctrl+F (⌘F on Mac) in a stream, or click the magnifier button in the header (its tooltip reads "Search in conversation"). A search bar opens above the messages.

- It finds messages that contain the text you type, ignoring upper and lower case.
- The counter shows your position, such as 2/7, or "No results".
- Enter goes to the next result (newer), Shift+Enter to the previous (older), and Esc closes the bar.
- It works in encrypted streams too, because the messages are matched after they are decrypted in your browser.

Conversation search isn't available inside a thread or in an unsent draft.
