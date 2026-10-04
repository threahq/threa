---
title: Formatting text
summary: The formatting toolbar, keyboard shortcuts and the markdown you can type to format a message.
section: messages
order: 2
---

# Formatting text

The composer supports bold, italic, strikethrough, inline code, links, quotes, lists, headings, code blocks, tables and math. You can use the toolbar, a keyboard shortcut, or type markdown and let the editor convert it as you go.

## The toolbar

On desktop, select text and a floating toolbar appears above it. You can also select the **Aa** (**Formatting**) button in the action bar to pin the toolbar inside the composer. On a phone, the toolbar only opens from the **Aa** button.

The toolbar has:

- A style menu: **Normal**, **Heading 1**, **Heading 2**, **Heading 3**.
- **Bold**, **Italic**, **Strikethrough**, **Inline code**, **Math** and **Link**.
- **Quote**, **Bullet list**, **Numbered list**, **Code block** and **Insert table**.
- On a phone, **Indent** and **Dedent** buttons.

**Link** opens a field for the address (the placeholder is `https://example.com`) and a **Remove** button for an existing link. Typed or pasted web addresses also become links automatically.

When the cursor is inside a table, the table button becomes **Edit table**, with these items: **Add row above**, **Add row below**, **Add column left**, **Add column right**, **Delete row**, **Delete column** and **Delete table**. A new table has three rows and three columns, with a header row. In a table, Tab moves to the next cell and adds a row after the last one.

## Keyboard shortcuts

| Format        | Windows and Linux | Mac   |
| ------------- | ----------------- | ----- |
| Bold          | `Ctrl+B`          | `⌘B`  |
| Italic        | `Ctrl+I`          | `⌘I`  |
| Strikethrough | `Ctrl+Shift+S`    | `⌘⇧S` |
| Inline code   | `Ctrl+E`          | `⌘E`  |
| Code block    | `Ctrl+Shift+C`    | `⌘⇧C` |

You can rebind these in the **Composer** tab of your [settings](app:settings/keyboard). Tab indents and Shift+Tab dedents. Inside a code block, they indent and dedent the selected lines.

## Typing markdown

These convert to formatting as you type the closing character:

- `**bold**` or `__bold__`
- `*italic*` or `_italic_`
- `~~strikethrough~~`
- `` `inline code` ``

These work at the start of a line:

- `# `, `## ` or `### ` followed by a space makes a heading.
- `- `, `+ ` or `* ` makes a bullet list. `1. ` makes a numbered list.
- `> ` makes a quote.
- Three backticks, optionally followed by a language name such as `js`, then Enter, starts a code block.
- A table written with pipes, a header row and a `| --- |` separator row becomes a table when you press Enter at the end of it.

## Math

Type `$x^2$` and the equation turns into a rendered formula when you type the closing `$`. `$$` on its own line followed by Enter starts a centered equation. Select an equation, or move the cursor onto it, to edit its TeX. The **Math** toolbar button turns the selected text into an equation or starts an empty one.

A dollar amount such as `$5 and $10` stays plain text.

## Pasting

Pasted text is read as markdown, so `**bold**` or a pasted list arrives formatted. Pasting a web address while text is selected turns the selection into a link to that address. Press Ctrl+Shift+V (⌘⇧V on Mac) to paste without formatting: the markdown is rendered to the text it stands for, with no bold, links or block structure.
