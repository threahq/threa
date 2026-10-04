---
title: Search filters
summary: Narrow a search by author, participants, stream, stream type, status and date, by typing a filter or picking one from the menu.
section: search
order: 2
---

# Search filters

A filter narrows a search to part of the workspace. Type it into the search box next to your words, or build it with the **Add filter** button. Active filters show as chips you can remove.

## The filters

- `from:@name` finds messages written by one person, agent or bot.
- `with:@name` finds messages in streams that person takes part in. Name several people and a stream must include all of them.
- `in:#channel` searches one channel and the threads under it.
- `in:@name` searches your direct message with that person. If you have no direct message with them, there are no results.
- `is:` limits the stream type to `scratchpad`, `channel`, `dm` or `thread`. Give more than one and a stream can match any of them. `type:` works the same way.
- `status:` takes `active` or `archived`. Without it, search covers both. Archived content includes anything under an archived stream.
- `after:YYYY-MM-DD` finds messages on or after that day.
- `before:YYYY-MM-DD` finds messages before that day.

Dates start at midnight in your device's time zone. For example, `after:2026-01-01 before:2026-02-01` covers January.

Put a phrase in double quotes to require messages that contain that text, ignoring upper and lower case. A search takes up to five quoted phrases.

## Pick a filter from the menu

**Add filter** opens a list with a "Filter by..." search box:

- **From user**, **With user**, **In channel** and **In DM with** open a picker with a search box.
- **Stream type** offers Scratchpad, Channel, Direct Message and Thread.
- **Status** offers Active and Archived.
- **After date** and **Before date** offer presets such as Today, Yesterday and Last month, or **Pick a date...** for a calendar.

Typing a filter prefix such as `from:`, `in:` or `status:` in the search box also opens suggestions.

## Good to know

- A filter that can't be understood is skipped without a message: an unknown person or channel, a date that isn't `YYYY-MM-DD`, or a status other than active or archived (search then covers active streams only). The chip still shows, so a chip doesn't prove the filter applied. If results look too broad, check the spelling of each name, channel and date.
- `with:` looks at who is in the stream, so it doesn't mean the person wrote the message. Use `from:` for that.
- Filters only narrow what you can already open. They don't reveal private streams.

For the basics of searching, see [Searching Threa](/guide/search-basics).
