---
title: Customizing the sidebar
summary: Reorder sections, add Inbox, type, label and custom sections, file streams into sections, and set how each section sorts and filters.
section: conversations
order: 13
---

# Customizing the sidebar

The sidebar is an ordered list of sections, and you decide which sections exist and in what order. Changes save as you make them and follow you to your other devices. For what the default layout contains, see [A tour of the sidebar](/guide/sidebar-tour).

## The editor

Open the user menu at the bottom of the sidebar and choose **Customize sidebar**. The row is hidden when there is nothing to customize yet, and on the board page. The editor has three parts:

- **Preset** switches between **Smart** (Important, Recent and Everything Else) and **All** (Scratchpads, Channels and Direct Messages). **Reset preset** returns to the preset you started from and is enabled only after you have changed the layout.
- **Sections** is the current list. Drag a row by its grip to reorder it, or focus the grip and use Space to lift, the arrow keys to move and Space to drop. Each row has a remove button.
- **Available to add** lists the sections you do not have yet. Click one to append it, or drag it to the position you want.

The sections you can add are:

- **Quick Links**, whose links are listed beneath it in the editor, where you can reorder them and set each to show or hide. Drafts, Saved, Scheduled and Activity also offer show when active, which shows the link only while it has something to show.
- **Inbox**, which lists streams with unread messages. A stream in the Inbox appears only there and returns to its usual section once it leaves the Inbox. By default that happens when you reply or react. Change it under **Settling** in [Appearance settings](app:settings/appearance).
- **Important**, **Recent** and **Everything Else**.
- **Scratchpads**, **Channels** and **Direct Messages**, one section per stream type.
- A section for each of your [labels](/guide/labels), shown with the label's colour and name.

Under **Create a custom section**, enter a name and select **Add section** to make a section of your own. Rename a custom section by editing its name in the list.

## How streams are placed

A stream appears in one section. Sections are resolved from the top, and a stream already shown above is left out of those below. Two kinds of placement override the order of the list:

- A stream you filed into a custom section appears only there.
- A stream carrying a label that has its own section appears under that section instead of in an automatic one.

If a stream is in both, the custom section wins. Streams in the Inbox show there, if you have it, whatever their other placement.

## File a stream into a section

Choose **Add to section…** from a stream's menu in the sidebar. A picker titled **Add to section** lists your custom sections with a check mark on the current one. Choose another to move the stream, choose the current one to take it out, or type a name under "New section name…" to create a section and file the stream in one step.

On a desktop browser you can also drag a stream row onto a custom section to file it there. Dropping onto a label section applies that label to the stream and takes it out of any custom section. Dragging is off on touch devices, which use **Add to section…**.

When you drag a labeled stream out of its label section into a custom section or another label, Threa asks whether to keep the old label. The dialog is titled "Remove the <label name> label?" and offers **Keep label** and **Remove label**, plus a **Remember my choice** checkbox. You can set this ahead of time under **Moving labeled streams** in [Appearance settings](app:settings/appearance): **Ask each time**, **Remove the old label** or **Keep the old label**.

## Filter and sort a section

Each section header has a view options button, labelled with the section name followed by "view options". It opens a menu with these groups:

- **Show**, which switches between **All** and **Unread**. Not every section has it.
- **Sort**, with the orders that section supports: Default, Arrival, Latest activity, A–Z and Recently joined. Choosing the current order again reverses it.

A section with a non-default view has a tinted button. The options are not available while you are on the board page.
