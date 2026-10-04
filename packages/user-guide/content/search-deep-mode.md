---
title: Deep search and grouped results
summary: What the improved search setting adds, including conversation rows, memory chips, Refine, and deep search used by agents.
section: search
order: 3
---

# Deep search and grouped results

This article describes search behavior that is not available in every workspace yet. It depends on a setting called `search` that is off by default and is switched on per workspace or per user. If you don't see a **Refine** button next to **Add filter** in the search panel or on the [Search](app:search) page, your workspace still uses the standard search described in [Searching Threa](/guide/search-basics).

## What changes when it is on

- Keyword matching for several words finds messages that contain any of them. With the setting off, keyword matching needs all of them. Messages with a similar meaning are found either way.
- Results can include conversations that matched through their topic, marked with a "topic" chip, and memory chips from the [Memory](app:memory) page. Matching messages are grouped by conversation either way.
- The **Refine** button appears next to **Add filter**, once you have typed a query.
- The row menu gains **More like this** and **Drop** on rows that belong to a conversation.

## Conversation rows and memory chips

A conversation row shows the topic title, the message count and the participants. A "topic" chip means the conversation matched through its topic rather than through one message. Matching messages sit under the row, followed by "N more in this conversation" when further messages in it also match. On a phone the row shows "N matches of M" instead.

Memory chips on a row show the title of a memory made from that conversation. Selecting one opens it on the [Memory](app:memory) page.

The **Grouped** and **Ranked** buttons control the layout. Grouped puts conversation rows under a collapsible header for each stream. Ranked lists every conversation row in rank order and names its stream on each row. See [Searching Threa](/guide/search-basics) for how the choice is remembered.

## Refine

**Refine** lets you narrow the current results in plain words, for example to keep some results, drop others, or say what should come first. A model reads the result list, so it takes a few seconds.

- Type the instruction in the field that says "Keep, drop, or reorder in plain words", then choose **Apply refinement**. An instruction can be up to 200 characters, and you can keep up to 5 refinements at once.
- Each refinement shows as a chip you can remove, and you can edit the ones you wrote in words.
- A short note from the model appears under the results summary.
- If a refinement fails after two tries, Threa shows all results and the message "Couldn't apply the refinement after two tries. Showing all results." with a **Retry** option.

The refinements are stored in the page address, so a shared link or a refresh keeps them.

Open the row menu with the ⋮ **Row actions** button, a right-click, or a long press. **More like this** adds a refinement for more results like that conversation. **Drop** removes that conversation from the results.

## Deep search for agents

Deep search rewrites a query into up to three alternative phrasings, searches with each, and combines the lists before ranking. It falls back to a single search if the rewrite step fails.

There is no switch for it in the search box. It also needs the `search` setting on. It is used when an agent searches the workspace for you, for example Ariadne with her workspace search, unless the agent asks for an exact text match.
