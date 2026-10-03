---
title: Snippets, GIFs and link previews
summary: Attach a block of text or code as a snippet, add a GIF with /giphy, and how link previews appear under messages.
section: messages
order: 12
---

# Snippets, GIFs and link previews

A snippet attaches a block of text or code as a file. `/giphy` adds a GIF to a message when your workspace has GIF search set up. Links you send turn into preview cards under the message.

## Snippets

Create a snippet in either of two ways:

- Type `/snippet` in the composer and pick it from the list.
- Open the command palette and choose **Create snippet**. It opens the editor in the composer of the stream you are in.

Both open the **Add as snippet** dialog. Give the snippet a file name in **Snippet filename** and write or paste the text. The **Snippet format** menu offers Plain text, JSON, YAML, XML, HTML, CSV and Markdown. Picking a format changes the file extension, and changing the extension in the name changes the format. A name with no recognized extension is treated as plain text.

Press **Attach snippet** or Ctrl+Enter (⌘Enter on Mac) to save. Enter adds a new line in the text. The snippet becomes an attachment chip at the cursor, and it is sent as a file with the message. See [Attachments and the Files page](/guide/attachments-and-files).

The editor is a plain text box with no syntax highlighting. It shows the number of characters and lines.

A very large paste (4 MiB or more) opens the same editor automatically, with a suggested file name and a format guessed from the content. Smaller pastes go into the message as normal text.

## GIFs with /giphy

Type `/giphy` and pick it from the list to open the **Add a GIF** dialog. With nothing typed in its **Search GIPHY** box it shows trending GIFs; typing a query searches. Results are capped at the PG-13 rating. Choose a GIF to insert it into your message.

`/giphy` only appears in workspaces where the server has a Giphy key configured. If you don't see it in the list, your workspace doesn't have it. A GIF is loaded from Giphy when someone views the message, and it is not uploaded to Threa.

## Link previews

When you send a message that contains links, Threa adds a preview card under it for up to five of them. What a card shows depends on the link:

- Web pages show the site, title, description and image.
- Image links show the image, and selecting it opens the image gallery.
- Video links show a video preview.
- GitHub and Linear links show a card for the pull request, issue or similar item once an admin has connected that service. See [GitHub and Linear](/guide/github-and-linear).
- Links to a message, memo or conversation in Threa show a card with a snippet, if you can open the target. What you see depends on your own access.
- Links to a channel are shown as a channel chip in the text and get no card.

Editing a message and removing a link removes its preview.

On each web preview card, the arrow at the left of the header (**Collapse preview**) folds the card into a one-line chip. Select the chip to open it again. Your choice is remembered per message in your browser. **Dismiss preview** (the x) hides that preview for you only. Other people still see it.

At most three previews on a message start open, and further web previews start folded to chips. Further previews of Threa links are hidden behind a **Show N more previews** button.
