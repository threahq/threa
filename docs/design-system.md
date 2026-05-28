# Threa Design System

> ## ⚠ Status: aspirational reference — not the source of truth
>
> This document captures the **design intent** for Threa's visual language —
> it was written ahead of (and alongside) implementation, and significant
> sections have since drifted from what actually ships in `apps/frontend/`.
> Treat it as a vocabulary, philosophy, and rough visual brief, **not** as a
> contract.
>
> **For ground-truth UI facts — actual tokens, real component structure,
> file pointers — read [`DESIGN.md`](../DESIGN.md) at the repo root.** That
> doc walks the running code feature-by-feature and is updated when the
> code changes.
>
> A drift catalog at the bottom of this file lists every known
> discrepancy with the correct value and a pointer to the owning code.
> When this doc and the code disagree, the code wins; fix the doc.

A comprehensive reference for Threa's visual design language. Use this document when implementing UI components and patterns.

**Design Philosophy:** Bold, modern, "AI-native" aesthetic for professionals at tech companies. The golden thread motif (inspired by Ariadne) provides warmth and distinction without being flashy.

**Visual Reference:** See `docs/design-system-kitchen-sink.html` for a complete interactive demo of all components and patterns with working code examples. The kitchen sink should be updated whenever new components or patterns are added. (Note: the kitchen sink is _also_ an aspirational artifact — many surfaces in there were never shipped, and some that shipped diverged. Cross-check against `DESIGN.md` and the real code.)

---

## Typography

### Primary Font: Space Grotesk

A geometric sans-serif with technical character. Gives Threa a distinctive, modern feel that stands out from generic system fonts.

**Source:** Google Fonts (free)

```html
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link
  href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&display=swap"
  rel="stylesheet"
/>
```

**Weights:**
| Weight | Usage |
|--------|-------|
| 400 | Body text, descriptions |
| 500 | UI labels, meta text |
| 600 | Headings, emphasis |
| 700 | Hero text, titles |

**Fallback Stack:**

```css
font-family:
  "Space Grotesk",
  system-ui,
  -apple-system,
  BlinkMacSystemFont,
  "Segoe UI",
  sans-serif;
```

### Accessibility Options

Users can override the default font:

- **System** - Native system fonts
- **Monospace** - For users who prefer fixed-width
- **OpenDyslexic** - For users with dyslexia

---

## Color System

### The Golden Thread Theme

Warm neutrals with gold/amber accents. The gold appears sparingly as the "guiding thread" through the interface.

### Light Mode

```css
:root {
  /* Base canvas - subtle warm tint */
  --background: 40 20% 98%;
  --foreground: 30 10% 12%;

  /* Cards/popovers */
  --card: 40 15% 99%;
  --card-foreground: 30 10% 12%;
  --popover: 40 15% 99%;
  --popover-foreground: 30 10% 12%;

  /* Primary - The Golden Thread */
  --primary: 38 65% 50%;
  --primary-foreground: 40 20% 98%;

  /* Secondary */
  --secondary: 35 10% 92%;
  --secondary-foreground: 30 15% 25%;

  /* Muted */
  --muted: 35 12% 93%;
  --muted-foreground: 30 8% 45%;

  /* Accent */
  --accent: 40 50% 94%;
  --accent-foreground: 35 60% 35%;

  /* Borders and inputs */
  --border: 35 15% 88%;
  --input: 35 15% 88%;
  --ring: 38 65% 50%;

  /* Sidebar */
  --sidebar-background: 35 15% 96%;
  --sidebar-foreground: 30 10% 25%;
}
```

### Dark Mode

```css
.dark {
  /* Base canvas - deep charcoal with warmth */
  --background: 30 15% 8%;
  --foreground: 35 15% 92%;

  /* Cards/popovers */
  --card: 30 12% 11%;
  --card-foreground: 35 15% 92%;
  --popover: 30 12% 11%;
  --popover-foreground: 35 15% 92%;

  /* Primary - adjusted for dark */
  --primary: 40 55% 55%;
  --primary-foreground: 30 15% 8%;

  /* Secondary */
  --secondary: 30 10% 18%;
  --secondary-foreground: 35 12% 85%;

  /* Muted */
  --muted: 30 10% 15%;
  --muted-foreground: 35 10% 55%;

  /* Accent */
  --accent: 35 25% 18%;
  --accent-foreground: 40 45% 70%;

  /* Borders and inputs */
  --border: 30 10% 20%;
  --input: 30 10% 15%;
  --ring: 40 55% 55%;

  /* Sidebar */
  --sidebar-background: 30 15% 6%;
  --sidebar-foreground: 35 12% 85%;
}
```

### Semantic Colors

| Purpose        | Color              | Usage                           |
| -------------- | ------------------ | ------------------------------- |
| **Channel**    | `--primary`        | Channel icons, # symbol         |
| **Scratchpad** | `hsl(280 60% 70%)` | Purple tint for personal spaces |
| **DM**         | `--secondary`      | Neutral for direct messages     |
| **Command**    | `hsl(200 60% 70%)` | Blue tint for actions           |
| **Search**     | `hsl(150 60% 70%)` | Green tint for search results   |
| **Hot/Active** | `--primary`        | Activity indicators             |
| **Stalled**    | `hsl(45 70% 60%)`  | Yellow for attention needed     |

---

## Spacing & Radius

### Border Radius

| Element            | Radius                   |
| ------------------ | ------------------------ |
| **Modals/Dialogs** | 16px                     |
| **Cards**          | 12px                     |
| **Buttons**        | 8-10px                   |
| **Inputs**         | 12px                     |
| **Items (list)**   | 8-10px                   |
| **Badges/Pills**   | 6px (small), 20px (pill) |
| **Avatars**        | 8px                      |

### Standard Spacing

Use multiples of 4px. Common values:

- **4px** - Tight gaps
- **8px** - Default gap
- **12px** - Comfortable padding
- **16px** - Section padding
- **20px** - Modal padding
- **24px** - Section margins

---

## Components

### Message Input

**Style:** Premium Glow

```css
.input-wrapper {
  position: relative;
  background: hsl(var(--input));
  border: 1px solid hsl(var(--border));
  border-radius: 12px;
}

.input-glow {
  position: absolute;
  inset: -2px;
  border-radius: 14px;
  background: linear-gradient(135deg, hsl(var(--primary) / 0.2), hsl(var(--primary) / 0.05), hsl(var(--primary) / 0.2));
  opacity: 0;
  transition: opacity 0.3s ease;
  pointer-events: none;
}

.input-wrapper:focus-within .input-glow {
  opacity: 1;
}
```

**Height Limits:**
| Component | Min | Max |
|-----------|-----|-----|
| Text input | 40px | 200px (then internal scroll) |
| Attachment bar | 0 (hidden) | 120px (then internal scroll) |
| Total input area | 64px | ~380px |

**Growth Behavior:** Push (stream view shrinks, auto-scrolls to bottom)

### Floating Selection Toolbar

**Style:** Icon-only

Appears above selected text for formatting actions.

```css
.selection-toolbar {
  display: flex;
  gap: 2px;
  padding: 4px;
  background: hsl(var(--popover));
  border: 1px solid hsl(var(--border));
  border-radius: 8px;
  box-shadow: 0 4px 12px hsl(0 0% 0% / 0.2);
}

.toolbar-btn {
  width: 32px;
  height: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 6px;
  color: hsl(var(--muted-foreground));
  transition: all 0.15s;
}

.toolbar-btn:hover {
  background: hsl(var(--secondary));
  color: hsl(var(--foreground));
}
```

**Actions:** Bold, Italic, Strikethrough, Code, Link

### Attachments

**Uploaded State:**

```css
.attachment-chip {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  background: hsl(var(--primary) / 0.1);
  border: 1px solid hsl(var(--primary) / 0.3);
  border-radius: 8px;
  font-size: 12px;
  color: hsl(var(--primary));
}
```

**Uploading State:**

```css
.attachment-chip.uploading {
  border-style: dashed;
  background: transparent;
  color: hsl(var(--muted-foreground));
  border-color: hsl(var(--border));
}
/* Include spinner icon */
```

**Inline References:**

```css
.inline-ref {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  background: hsl(var(--primary) / 0.15);
  border: 1px solid hsl(var(--primary) / 0.3);
  border-radius: 6px;
  font-size: 13px;
  font-weight: 500;
  color: hsl(var(--primary));
  vertical-align: middle;
}
```

Format: `[Image #1]`, `[filename.ext]`

### Code Blocks

**Reference:** `design-system-kitchen-sink.html` section "CODE BLOCK WITH HEADER"

Code blocks use a Linear-inspired header design with language picker (editing mode) or copy button (viewing mode).

**Header:**

```css
.code-block {
  border-radius: 10px;
  background: hsl(var(--muted) / 0.5);
  border: 1px solid hsl(var(--border));
  overflow: hidden;
}

.code-block-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  background: hsl(var(--muted) / 0.5);
  border-bottom: 1px solid hsl(var(--border));
  min-height: 36px;
}
```

**Language Picker (Editing):**
Dropdown on right side of header for selecting syntax highlighting.

**Copy Button (Viewing):**
Appears on hover, shows checkmark when copied.

```css
.code-block-copy {
  width: 28px;
  height: 28px;
  opacity: 0;
  transition: opacity 0.15s;
}

.code-block:hover .code-block-copy {
  opacity: 1;
}

.code-block-copy.copied {
  background: hsl(var(--success) / 0.15);
  color: hsl(var(--success));
}
```

### Image Attachments & Gallery

**Reference:** `design-system-kitchen-sink.html` section "IMAGE ATTACHMENTS & GALLERY"

**Single Image:**

```css
.image-preview.single {
  max-width: 400px;
  max-height: 300px;
  border-radius: 8px;
  border: 1px solid hsl(var(--border));
  cursor: pointer;
}
```

**Multiple Images:**
Grid layout with fixed size:

```css
.image-preview-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.image-preview.multi {
  width: 180px;
  height: 180px;
}
```

**"More" Overlay:**
When >4 images, show "+N more" on 4th thumbnail:

```css
.image-preview-overlay {
  position: absolute;
  inset: 0;
  background: hsl(0 0% 0% / 0.6);
  display: flex;
  align-items: center;
  justify-content: center;
  color: white;
  font-size: 18px;
  font-weight: 600;
}
```

**Full-Screen Gallery:**
Click any image to open full-screen viewer with:

- Navigation arrows (prev/next)
- Thumbnail strip at bottom
- Download and close buttons
- Dark backdrop (95% black)

### Message Styling

**Reference:** `design-system-kitchen-sink.html` section "MESSAGE STYLING"

**Standard Message:**

```css
.message {
  display: flex;
  gap: 14px;
  margin-bottom: 20px;
}

.message-avatar {
  width: 36px;
  height: 36px;
  border-radius: 10px;
  flex-shrink: 0;
}
```

**AI Message (Special Styling):**
AI messages get a gold accent and subtle background:

```css
.message.ai {
  background: linear-gradient(90deg, hsl(var(--primary) / 0.06) 0%, transparent 100%);
  margin-left: -24px;
  margin-right: -24px;
  padding: 16px 24px;
  border-left: 3px solid hsl(var(--primary));
}

.message.ai .message-avatar {
  background: hsl(var(--primary));
  color: hsl(var(--primary-foreground));
}

.message.ai .message-author {
  color: hsl(var(--primary));
}
```

This creates a subtle "golden thread" visual for AI contributions.

**Message Context Menu ("..."):**

All messages (both user and AI) include a context menu button that appears on hover, aligned with the author name and timestamp in the message header.

```css
.message {
  position: relative;
}

.message-header {
  display: flex;
  align-items: center;
  gap: 8px;
}

.message-menu-button {
  margin-left: auto; /* Pushes button to the right */
  width: 24px;
  height: 24px;
  border-radius: 6px;
  background: hsl(var(--card));
  border: 1px solid hsl(var(--border));
  display: none;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: all 0.15s;
  box-shadow: 0 2px 8px hsl(0 0% 0% / 0.1);
  flex-shrink: 0;
}

.message:hover .message-menu-button {
  display: inline-flex;
}

.message-menu-button:hover {
  background: hsl(var(--muted));
  border-color: hsl(var(--primary) / 0.3);
}
```

**Menu icon:** Three vertical dots (•••)

**Dropdown menu styling:**

```css
.message-context-menu {
  position: absolute;
  top: 32px; /* Just below the message header */
  right: 0; /* Aligned with right edge of message */
  background: hsl(var(--card));
  border: 1px solid hsl(var(--border));
  border-radius: 8px;
  padding: 4px;
  box-shadow: 0 8px 24px hsl(0 0% 0% / 0.15);
  min-width: 200px;
  z-index: 100;
  display: none;
}

.menu-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 12px;
  border-radius: 6px;
  font-size: 14px;
  cursor: pointer;
  transition: background 0.15s;
}

.menu-item:hover {
  background: hsl(var(--muted));
}

.menu-item svg {
  width: 16px;
  height: 16px;
  color: hsl(var(--muted-foreground));
}
```

**HTML structure:**

```html
<div class="message">
  <div class="message-avatar">K</div>
  <div class="message-content">
    <div class="message-header">
      <span class="message-author">Kris</span>
      <span class="message-time">2:30 PM</span>
      <button class="message-menu-button">•••</button>
    </div>
    <p class="message-text">Message content...</p>
  </div>
  <div class="message-context-menu">
    <!-- Menu items -->
  </div>
</div>
```

**Interaction behavior:**

- **Show button:** Appears on message hover, inline with author name and timestamp
- **Open menu:** Click the "..." button
- **Close menu:** Click the button again OR click outside the menu

**Menu positioning:** The dropdown opens below the message header (`top: 32px`) and aligns with the right edge of the message. This prevents the menu from covering the message content while keeping it visually connected to the header where the button appears.

**Common menu items:**

- **User messages:** Copy message, Edit, Delete, Start thread, Save as memo
- **AI messages:** Show trace and sources (primary), Copy message, Save as memo

**For AI messages specifically:** The "Show trace and sources" option is the primary way to access the agent's reasoning steps and sources. This keeps the message view clean while making transparency easily accessible.

### Inline Mentions

**Reference:** `design-system-kitchen-sink.html` section "MENTIONS"

Inline mentions in message text use subtle backgrounds:

```css
.inline-mention {
  display: inline;
  padding: 1px 4px;
  border-radius: 4px;
  font-weight: 500;
  cursor: pointer;
}

/* User mentions */
.inline-mention.user {
  background: hsl(200 70% 50% / 0.1);
  color: hsl(200 70% 50%);
}

/* AI persona mentions */
.inline-mention.ai {
  background: hsl(var(--primary) / 0.1);
  color: hsl(var(--primary));
}

/* Channel mentions */
.inline-mention.channel {
  background: hsl(var(--muted));
  color: hsl(var(--foreground));
}

/* Current user (me) - stronger highlight */
.inline-mention.me {
  background: hsl(200 70% 50% / 0.15);
  color: hsl(var(--primary));
  font-weight: 600;
}
```

### Popovers

#### Emoji Picker

- **Style:** Standard with categories
- **Behavior:** When typing `:text`, use typed text as search (no top bar needed)

#### Slash Commands

- **Style:** Floating pill
- **Sorting:** By relevance (best match at top), NOT grouped by type
- **Type indicators:** Icons and/or colors indicate command type

```css
.command-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  border-radius: 8px;
}

.command-icon {
  width: 28px;
  height: 28px;
  border-radius: 6px;
  display: flex;
  align-items: center;
  justify-content: center;
}
```

#### Mentions

- **Style:** Floating compact
- **Sorting:** By relevance (best match at top), NOT grouped by type
- **Triggers:** `@` for users/personas, `#` for channels

### Document Editor Modal

For long-form content and announcements.

```css
.doc-editor {
  width: 90%;
  max-width: 800px;
  max-height: 80vh;
  background: hsl(var(--card));
  border: 1px solid hsl(var(--border));
  border-radius: 16px;
  display: flex;
  flex-direction: column;
  box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.5);
}
```

**Features:**

- Full formatting toolbar
- No Enter-to-send (explicit Send button)
- Preview mode
- Draft auto-save
- Schedule send option

---

## Patterns

### Thread Panels

**Modes:**
| Mode | Behavior |
|------|----------|
| **Locked** | Side-by-side resizable layout (default), max 3 panels |
| **Full-screen** | Expands to fill entire view |

**Resize:** Drag handle between panels with 20% minimum width

**Breadcrumbs:** Full ancestor chain from root → intermediate threads → current thread. Each breadcrumb item truncates at 120px to prevent overflow.

**Panel Limit:** Maximum of 3 total panels (main stream + 2 thread panels). Opening a new panel when at limit automatically closes the oldest panel.

```css
.thread-panel {
  background: hsl(var(--card));
  border-left: 1px solid hsl(var(--border));
  display: flex;
  flex-direction: column;
}

.thread-tabs {
  display: flex;
  gap: 2px;
  padding: 8px 12px;
  border-bottom: 1px solid hsl(var(--border));
  overflow-x: auto;
}

.thread-tab {
  padding: 6px 12px;
  border-radius: 6px;
  font-size: 13px;
  white-space: nowrap;
}

.thread-tab.active {
  background: hsl(var(--primary) / 0.15);
  color: hsl(var(--primary));
}
```

### Sidebar with Urgency Strip

**Reference:** `design-system-kitchen-sink.html` section "SIDEBAR"

The sidebar features a 6px urgency strip on the left edge that provides at-a-glance priority information. The sidebar can collapse to just the urgency strip (like Linear).

**Structure:**

```css
.smart-sidebar {
  display: flex;
  flex-direction: column;
  width: 280px;
}

.smart-sidebar-body {
  display: flex;
  overflow-y: auto;
}

.urgency-strip {
  width: 6px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  /* Scrolls with content inside .smart-sidebar-body */
}

.urgency-segment {
  flex-shrink: 0;
  /* Height matches corresponding stream item */
  /* Background color based on urgency: red, blue, gray, gold */
}

.smart-sidebar-streams {
  flex: 1;
  padding: 8px;
}
```

**Urgency Strip:**
The strip is a 6px column that scrolls with the sidebar content. Each stream item has a corresponding segment on the strip showing its urgency level:

- **Red** - Mentions (especially many) - most urgent, needs attention
- **Blue** - Activity in threads/conversations you're in - medium priority
- **Muted/gray** - Quiet streams - low priority
- **Gold** (future) - AI activity indicator

**Implementation:** The strip is positioned inside the scrollable area (`.smart-sidebar-body`), not as a fixed element. Each stream item's height determines its strip segment height. As you scroll the sidebar, the strip scrolls with it, maintaining the visual connection between strip color and stream item.

**Not tied to labels:** The strip shows urgency per item, whether organized by smart sections, labels, or type-based views.

**Collapse Behavior:**

- Default: Collapsed to just urgency strip (6px)
- Hover: Preview expansion (triggered by 15px invisible hover margin or urgency strip)
- Click: Pin open (persists until clicked again)
- When collapsed, urgency distribution still visible

**Resize & Persistence:**

- Independent resizable widths for preview (hover) and pinned states
- Width constraints: min 200px, max 600px
- 4px draggable resize handle on right edge when visible
- Widths persisted to localStorage:
  - `sidebar.width.preview` (default: 260px)
  - `sidebar.width.pinned` (default: 280px)
- Hover margin: 15px invisible zone (reduced from 30px to prevent accidental triggers)

### Sidebar Organization: Smart Auto-Sections

**Reference:** `docs/references/mockups/sidebar-organization-exploration.html`

The sidebar uses **Smart Auto-Sections** to surface important information at scale without requiring user-defined labels. This pattern works for 10 streams or 100+ streams.

**Core Principle:** Automatic organization that surfaces what matters, with manual override.

#### View Modes

```css
.view-toggle {
  display: flex;
  gap: 4px;
  background: hsl(var(--muted));
  border-radius: 6px;
  padding: 2px;
}

.view-toggle-btn.active {
  background: hsl(var(--card));
  color: hsl(var(--primary));
}
```

**Smart View (Default):**
Auto-organized sections based on activity patterns.

**All View:**
Type-based sections (Scratchpads / Channels / DMs) for inventory overview.

#### Smart Sections

**⚡ Important** (max 10 items)
Auto-populated based on signals that demand attention:

- Unread mentions (@you)
- Active AI conversations (last 1 hour)
- Unread messages in pinned streams
- Recent threads you participated in

Sorted by urgency score. Updates in real-time.

**🕐 Recent** (max 15 items)
Streams with activity in the last 7 days:

- Any stream you've sent messages in
- Any stream with new messages (not in Important)
- Sorted by last activity timestamp
- Excludes archived/muted streams

Auto-expires after 7 days of inactivity.

**📌 Pinned** (unlimited)
User-controlled, always visible:

- Manually pinned by user
- Persists regardless of activity
- Drag to reorder
- Right-click to unpin

**📂 Everything Else** (collapsed by default)
All other streams:

- Click to expand (shows all, scrollable)
- Use search to find specific items
- Can switch to "All" view for type-based organization
- Prevents overwhelming the sidebar

#### Stream Items

```css
.stream-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border-radius: 8px;
  cursor: pointer;
  transition: all 0.1s;
}

.stream-item:hover {
  background: hsl(var(--muted) / 0.5);
}

.stream-item.active {
  background: hsl(var(--primary) / 0.1);
}

.stream-avatar {
  width: 32px;
  height: 32px;
  border-radius: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 13px;
  font-weight: 600;
  flex-shrink: 0;
}

.stream-name {
  font-size: 13px;
  font-weight: 500;
  color: hsl(var(--foreground));
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.stream-preview {
  font-size: 11px;
  color: hsl(var(--muted-foreground));
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  margin-top: 2px;
}

.stream-time {
  font-size: 10px;
  color: hsl(var(--muted-foreground));
  flex-shrink: 0;
}
```

#### Density Modes

**Comfortable** (default):

- Shows preview text and metadata
- 40px item height
- Better for scanning content

**Compact:**

- Names and indicators only
- 32px item height
- Fits ~2x more items on screen
- Better for navigating large lists

```css
.sidebar-mockup.compact .stream-item {
  padding: 6px 10px;
}

.sidebar-mockup.compact .stream-avatar {
  width: 24px;
  height: 24px;
  font-size: 11px;
}

.sidebar-mockup.compact .stream-preview {
  display: none;
}
```

#### Quick Filters

- **Unread** - Show only streams with unread messages
- **Active** - Activity in last 24 hours
- **Pinned** - Show only pinned streams
- **Muted toggle** - Hide/show muted streams

#### Migration Path to Labels

When user-defined labels are added:

1. Smart sections remain the default view
2. View toggle adds "Labels" option (Smart / All / Labels)
3. Labels appear as badges in Smart view
4. Filter by label in any view
5. Unlabeled streams stay in "Uncategorized" section

**Hover Actions:** Pin, Mute, Rename (scratchpads), More menu

### Quick Switcher

**Trigger:** `Cmd+K` (streams), `Cmd+Shift+K` (commands), `Cmd+Shift+F` (search)

```css
.quick-switcher {
  width: 100%;
  max-width: 580px;
  background: hsl(var(--card));
  border: 1px solid hsl(var(--border));
  border-radius: 16px;
  box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.5);
}

.switcher-input-area {
  display: flex;
  align-items: center;
  padding: 16px 20px;
  border-bottom: 1px solid hsl(var(--border));
  gap: 12px;
}

/* Subtle glow on focus */
.switcher-input-area::before {
  content: "";
  position: absolute;
  inset: -1px;
  border-radius: 16px 16px 0 0;
  background: linear-gradient(135deg, hsl(var(--primary) / 0.15), transparent 50%, hsl(var(--primary) / 0.1));
  opacity: 0;
  transition: opacity 0.3s;
  pointer-events: none;
}

.switcher-input-area:focus-within::before {
  opacity: 1;
}
```

**Mode Tabs:** Pill style

```css
.mode-tab-pill {
  padding: 8px 14px;
  border-radius: 20px;
  font-size: 13px;
  font-weight: 500;
  background: hsl(var(--secondary));
  border: 1px solid transparent;
}

.mode-tab-pill.active {
  color: hsl(var(--primary));
  background: hsl(var(--primary) / 0.15);
  border-color: hsl(var(--primary) / 0.4);
}
```

**Items:** Include avatars, names, and message previews

**Search Results:** Highlight matches with gold background

```css
.search-result-text mark {
  background: hsl(var(--primary) / 0.3);
  color: hsl(var(--foreground));
  padding: 0 2px;
  border-radius: 2px;
}
```

**Footer:** Keyboard hints (↑↓ Navigate, ↵ Open, ⌘↵ New tab, esc Close)

### Top Bar

**Reference:** `design-system-kitchen-sink.html` section 15

The top bar provides workspace navigation and context.

```css
.top-bar {
  height: 44px;
  background: hsl(var(--card));
  border: 1px solid hsl(var(--border));
  display: flex;
  align-items: center;
  padding: 0 12px;
}
```

**Layout:**

- Left: Sidebar toggle, workspace switcher (~100px width)
- Center: Context labels (stream/thread indicators) with activity glow
- Right: Search, notifications, profile (~100px width)

**Activity Glow:**
Active streams show a subtle multi-color glow at the bottom of their label:

```css
.stream-label-glow {
  position: absolute;
  bottom: 2px;
  left: 10px;
  right: 10px;
  height: 3px;
  border-radius: 2px;
  display: flex;
  overflow: hidden;
}

.glow-stripe {
  flex: 1;
  height: 100%;
  animation: glow-pulse 2s ease-in-out infinite;
}

@keyframes glow-pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.5;
  }
}
```

Each active persona gets a color stripe in the glow, creating a visual "thread" of who's active.

### Agent Trace

**Reference:** `docs/references/mockups/agent-trace-with-sources.html`

Agent trace provides full transparency into AI agent reasoning and sources. It uses **bidirectional navigation** - users can access the trace from either the session event or by clicking on the AI message itself.

**Design Goals:**

- Show agent reasoning steps (thinking, tool calls, responses)
- Display sources used for each step
- Provide scroll-to-highlight for message-initiated traces
- Keep UI clean while maintaining full transparency

#### AI Message with Context Menu

AI messages in the stream have two ways to access the trace: click the message itself, or use the "..." context menu (like Slack).

**Message Container:**

```css
.message.ai {
  background: linear-gradient(90deg, hsl(var(--primary) / 0.06) 0%, transparent 100%);
  margin-left: -24px;
  margin-right: -24px;
  padding: 16px 24px;
  border-left: 3px solid hsl(var(--primary));
  cursor: pointer;
  transition: all 0.15s;
  position: relative;
}

.message.ai:hover {
  background: linear-gradient(90deg, hsl(var(--primary) / 0.1) 0%, transparent 100%);
}

.message-trace-hint {
  font-size: 11px;
  color: hsl(var(--primary));
  opacity: 0;
  transition: opacity 0.15s;
  margin-top: 4px;
}

.message.ai:hover .message-trace-hint {
  opacity: 1;
}
```

**Context Menu Button ("..."):**

```css
.message-menu-button {
  position: absolute;
  top: 8px;
  right: 8px;
  width: 28px;
  height: 28px;
  border-radius: 6px;
  background: hsl(var(--card));
  border: 1px solid hsl(var(--border));
  display: none;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: all 0.15s;
  box-shadow: 0 2px 8px hsl(0 0% 0% / 0.1);
}

.message.ai:hover .message-menu-button {
  display: flex;
}

.message-menu-button:hover {
  background: hsl(var(--muted));
  border-color: hsl(var(--primary) / 0.3);
}
```

**Dropdown Menu:**

```css
.message-context-menu {
  position: absolute;
  top: 40px;
  right: 40px; /* Opens to the left of button, not below it */
  background: hsl(var(--card));
  border: 1px solid hsl(var(--border));
  border-radius: 8px;
  padding: 4px;
  box-shadow: 0 8px 24px hsl(0 0% 0% / 0.15);
  min-width: 200px;
  z-index: 100;
}

/* Alternative: Position above the message on smaller screens */
@media (max-width: 480px) {
  .message-context-menu {
    top: auto;
    bottom: 100%;
    right: 8px;
    margin-bottom: 8px;
  }
}

.menu-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 12px;
  border-radius: 6px;
  font-size: 14px;
  cursor: pointer;
  transition: background 0.15s;
}

.menu-item:hover {
  background: hsl(var(--muted));
}

.menu-item svg {
  width: 16px;
  height: 16px;
  color: hsl(var(--muted-foreground));
}
```

**Menu Items:**

1. **Show trace and sources** (primary action) - Opens trace modal scrolled to this message's response step
2. **Copy message** - Copy message text to clipboard
3. **Save as memo** - Create a memo from this message

**Interaction behavior:**

- **Show button:** "..." button appears on hover in top-right corner of message
- **Open menu:** Click the "..." button to reveal menu
- **Close menu:** Click the button again OR click outside the menu
- **Alternative access:** Click message body directly → Opens trace scrolled to response (bypasses menu)

**Menu positioning:** The dropdown opens to the LEFT of the button (`right: 40px`) rather than directly below it. This prevents the menu from covering the message content. On smaller screens (<480px), the menu can optionally appear above the message.

**This is how users view sources:** Sources are not shown prominently in the message view; they're only accessible via the trace modal through either clicking the message body or using "Show trace and sources" from the menu.

#### Agent Session Event (In-Stream)

Compact event shown in the message stream after agent execution:

```css
.agent-session-event {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 14px;
  background: hsl(var(--muted) / 0.5);
  border: 1px solid hsl(var(--border));
  border-radius: 10px;
  cursor: pointer;
  transition: all 0.15s;
  font-size: 13px;
}

.agent-session-event:hover {
  background: hsl(var(--muted) / 0.7);
  border-color: hsl(var(--primary) / 0.3);
}

.session-status-icon.complete {
  width: 20px;
  height: 20px;
  background: hsl(var(--success) / 0.15);
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
}

.session-status-icon.complete svg {
  color: hsl(var(--success));
  width: 14px;
  height: 14px;
}

.session-expand-hint {
  font-size: 11px;
  color: hsl(var(--primary));
  opacity: 0;
  transition: opacity 0.15s;
}

.agent-session-event:hover .session-expand-hint {
  opacity: 1;
}
```

**Structure:**

- Status icon (checkmark for complete, spinner for running)
- Session info: "Session complete" with "5 steps • 6.3s • 1 message sent" on second line
- Hover hint: "View trace →"

#### Trace Modal

Full-screen modal showing agent session steps with collapsible sources:

```css
/* Modal Overlay & Animations */
.modal-overlay {
  position: fixed;
  inset: 0;
  background: hsl(0 0% 0% / 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
  animation: fadeIn 0.2s;
}

@keyframes fadeIn {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}

.modal-dialog {
  background: hsl(var(--card));
  border: 1px solid hsl(var(--border));
  border-radius: 16px;
  width: 90%;
  max-width: 800px;
  max-height: 85vh;
  display: flex;
  flex-direction: column;
  box-shadow: 0 24px 48px hsl(0 0% 0% / 0.3);
  animation: slideUp 0.25s ease-out;
}

@keyframes slideUp {
  from {
    opacity: 0;
    transform: translateY(20px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

/* Modal Header with Actions */
.modal-header {
  padding: 20px 24px;
  border-bottom: 1px solid hsl(var(--border));
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.modal-meta {
  display: flex;
  align-items: center;
  gap: 12px;
  font-size: 12px;
  color: hsl(var(--muted-foreground));
  margin-top: 4px;
}

/* Action buttons (settings, close) */
.modal-action-btn {
  width: 32px;
  height: 32px;
  border-radius: 6px;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: all 0.15s;
  color: hsl(var(--muted-foreground));
  position: relative;
}

.modal-action-btn:hover {
  background: hsl(var(--muted));
  color: hsl(var(--foreground));
}

.modal-action-btn.active {
  background: hsl(var(--primary) / 0.15);
  color: hsl(var(--primary));
}

/* Tooltips */
.tooltip {
  position: absolute;
  top: -32px;
  left: 50%;
  transform: translateX(-50%);
  background: hsl(var(--foreground));
  color: hsl(var(--background));
  padding: 4px 8px;
  border-radius: 4px;
  font-size: 11px;
  white-space: nowrap;
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.15s;
}

.modal-action-btn:hover .tooltip {
  opacity: 1;
}

/* Modal Footer */
.modal-footer {
  padding: 16px 24px;
  border-top: 1px solid hsl(var(--border));
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 12px;
  color: hsl(var(--muted-foreground));
}

/* Trace Steps */
.trace-step {
  padding: 20px 24px;
  border-bottom: 1px solid hsl(var(--border));
  animation: stepFadeIn 0.3s ease-out;
  scroll-margin-top: 20px;
}

@keyframes stepFadeIn {
  from {
    opacity: 0;
    transform: translateY(-10px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.trace-step.highlighted {
  background: hsl(var(--primary) / 0.08);
  animation: highlight-flash 2s ease-out;
}
```

**Modal Structure:**

- **Header:** Session title, persona name, time, duration, and action buttons
- **Action buttons:** Settings (gear icon) for trace preferences, close button
- **Tooltips:** Show on hover ("Trace preferences", etc.)
- **Body:** Scrollable list of trace steps
- **Footer:** Summary ("Session completed • 5 steps • 1 message sent")

**Interactions:**

- Click backdrop to close
- ESC key to close
- Settings button toggles streaming preference (active state shown)

**Step Types:**

Each step has an icon, colored badge, and background tint:

| Type         | Icon             | Color                     | Usage                | Label Examples                   |
| ------------ | ---------------- | ------------------------- | -------------------- | -------------------------------- |
| **Thinking** | Lightbulb        | Gold (`--primary`)        | Agent reasoning      | "Thinking"                       |
| **Tool**     | Magnifying glass | Blue (`hsl(200 70% 50%)`) | Tool calls           | "Web Search", "Search Workspace" |
| **Response** | Chat bubble      | Green (`--success`)       | Message sent to user | "Response"                       |

```css
/* Step background tints */
.trace-step.thinking {
  background: hsl(var(--primary) / 0.03);
}

.trace-step.tool {
  background: hsl(200 70% 50% / 0.03);
}

.trace-step.response {
  background: hsl(var(--success) / 0.03);
}

/* Step type badges */
.trace-step-type {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  border-radius: 6px;
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.trace-step-type.thinking {
  background: hsl(var(--primary) / 0.15);
  color: hsl(var(--primary));
}

.trace-step-type.tool {
  background: hsl(200 70% 50% / 0.15);
  color: hsl(200 70% 50%);
}

.trace-step-type.response {
  background: hsl(var(--success) / 0.15);
  color: hsl(var(--success));
}

/* Step header with type badge and duration */
.trace-step-header {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 12px;
}

.trace-step-time {
  font-size: 11px;
  color: hsl(var(--muted-foreground));
  margin-left: auto;
}
```

**Step Icons:**

```html
<!-- Thinking: Lightbulb -->
<svg class="icon" fill="none" stroke="currentColor" viewBox="0 0 24 24">
  <path
    stroke-linecap="round"
    stroke-linejoin="round"
    stroke-width="2"
    d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z"
  />
</svg>

<!-- Tool: Magnifying glass -->
<svg class="icon" fill="none" stroke="currentColor" viewBox="0 0 24 24">
  <path
    stroke-linecap="round"
    stroke-linejoin="round"
    stroke-width="2"
    d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
  />
</svg>

<!-- Response: Chat bubble -->
<svg class="icon" fill="none" stroke="currentColor" viewBox="0 0 24 24">
  <path
    stroke-linecap="round"
    stroke-linejoin="round"
    stroke-width="2"
    d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z"
  />
</svg>
```

#### Sources (Collapsible)

Sources appear inline on tool and response steps, collapsed by default:

```css
.sources-section {
  margin-top: 16px;
}

.sources-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  cursor: pointer;
  padding: 8px 0;
  user-select: none;
}

.sources-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  font-weight: 600;
}

.sources-count {
  background: hsl(var(--muted));
  color: hsl(var(--muted-foreground));
  padding: 2px 6px;
  border-radius: 10px;
  font-size: 11px;
  font-weight: 600;
}

.sources-chevron {
  width: 16px;
  height: 16px;
  color: hsl(var(--muted-foreground));
  transition: transform 0.2s;
}

.sources-header.expanded .sources-chevron {
  transform: rotate(90deg);
}

.sources-list {
  margin-top: 8px;
  display: none;
}

.sources-header.expanded + .sources-list {
  display: block;
}

.sources-results {
  margin-top: 10px;
  padding: 10px;
  background: hsl(var(--muted) / 0.3);
  border-radius: 6px;
  font-size: 12px;
}

/* Border color matches step type */
.trace-step.thinking .sources-results {
  border-left: 3px solid hsl(var(--primary));
}

.trace-step.tool .sources-results {
  border-left: 3px solid hsl(200 70% 50%);
}

.trace-step.response .sources-results {
  border-left: 3px solid hsl(var(--success));
}

.source-item {
  padding: 6px 10px;
  margin: 0 -10px;
  border-bottom: 1px solid hsl(var(--border));
  transition: background 0.15s ease;
  border-radius: 4px;
  cursor: pointer;
}

.source-item:hover {
  background: hsl(var(--muted) / 0.5);
}

.source-item:last-child {
  border-bottom: none;
}

.source-title {
  font-weight: 600;
  margin-bottom: 4px;
  font-size: 12px;
  transition: color 0.15s ease;
}

.source-item:hover .source-title {
  color: hsl(var(--primary));
}

.source-meta {
  font-size: 11px;
  color: hsl(var(--muted-foreground));
  margin-bottom: 4px;
}

.source-snippet {
  color: hsl(var(--muted-foreground));
  font-size: 11px;
  line-height: 1.4;
}
```

**Source Header:**

```html
<div class="sources-header" onclick="toggleSources(event)">
  <div class="sources-title">
    <!-- Document icon -->
    <svg class="icon" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path
        stroke-linecap="round"
        stroke-linejoin="round"
        stroke-width="2"
        d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z"
      />
    </svg>
    Sources
    <span class="sources-count">3</span>
  </div>
  <!-- Chevron that rotates when expanded -->
  <svg class="sources-chevron" fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" />
  </svg>
</div>
```

**Source Types:**

**Web Source** (clickable link):

- **Title:** Page title (bold, 12px)
- **Meta:** Domain (11px, muted)
- **Snippet:** Relevant excerpt (11px, muted, 2-line clamp)
- Entire item is `<a>` tag with `target="_blank"`

**Workspace Source** (clickable to navigate):

- **Title:** "Author in #channel" format (bold, 12px)
- **Meta:** "#channel • Yesterday at 3:42 PM" (11px, muted)
- **Snippet:** Message content excerpt (11px, muted)
- Entire item is clickable div

**Key Features:**

- All sources in one compact box with colored left border
- Border color matches step type (gold/blue/green)
- Collapsed by default, click header to expand
- Chevron rotates 90° when expanded
- Entire source item is hoverable/clickable
- Last item has no bottom border

#### Bidirectional Navigation

Users can open the trace from two entry points:

1. **Session event** (click) → Opens trace at top, no highlighting
2. **AI message** (click) → Opens trace scrolled to response step with highlight

```javascript
// Open from session event
function openTraceFromSession() {
  openModal(null) // No highlight
}

// Open from AI message
function openTraceFromMessage() {
  openModal(responseStepIndex) // Highlight the response step
}

// Modal opening logic
function openModal(highlightStepIndex) {
  const overlay = document.getElementById("modalOverlay")
  const body = document.getElementById("modalTraceBody")

  // Render trace steps (apply .highlighted class if highlightStepIndex matches)
  body.innerHTML = buildTraceSteps(highlightStepIndex)

  overlay.classList.add("active")

  // Scroll to highlighted step after modal animation completes
  if (highlightStepIndex !== null) {
    setTimeout(() => {
      const highlightedStep = body.querySelector(".trace-step.highlighted")
      if (highlightedStep) {
        highlightedStep.scrollIntoView({ behavior: "smooth", block: "center" })
      }
    }, 100)
  }
}

// Close on backdrop click
function closeModalOnBackdrop(event) {
  if (event.target.id === "modalOverlay") {
    closeModal()
  }
}

// Keyboard shortcuts
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    closeModal()
  }
})
```

**Navigation Behavior:**

- **From session event:** Trace opens at the top (first step visible)
- **From AI message:** Trace scrolls to center the response step
- **Backdrop click:** Closes modal
- **ESC key:** Closes modal
- **Smooth scroll:** Uses `scrollIntoView({ behavior: 'smooth', block: 'center' })`

#### Highlight Animation

```css
@keyframes highlight-flash {
  0%,
  100% {
    background: hsl(var(--primary) / 0.08);
  }
  50% {
    background: hsl(var(--primary) / 0.15);
  }
}

.trace-step.highlighted {
  background: hsl(var(--primary) / 0.08);
  animation: highlight-flash 2s ease-out;
}
```

**Animation Behavior:**

- **Duration:** 2 seconds
- **Easing:** ease-out
- **Pattern:** Starts at 8% opacity, pulses to 15%, returns to 8%
- **Scroll:** Smooth scroll centers the highlighted step
- **Works for:** Any step type (thinking, tool, response)
- **Applied when:** Opening trace from AI message click

#### User Preferences

**Streaming vs Instant Display:**

- **Streaming mode:** Steps appear one-by-one as agent works (like Claude.ai)
- **Instant mode:** Complete trace shown immediately
- **Toggle:** Settings button (gear icon) in modal header
- **Active state:** Settings button shows gold background when streaming enabled

```css
.modal-action-btn.active {
  background: hsl(var(--primary) / 0.15);
  color: hsl(var(--primary));
}
```

#### Content Rendering & Typography

Content within trace steps follows consistent formatting rules for readability:

**Step Body Text:**

```css
.trace-step-body {
  font-size: 14px;
  line-height: 1.6;
  color: hsl(var(--foreground));
}

.trace-step-body p {
  margin-bottom: 12px;
}

.trace-step-body p:last-child {
  margin-bottom: 0;
}

/* Preserve whitespace for code/preformatted content */
.trace-step-body pre {
  white-space: pre-wrap;
  word-wrap: break-word;
  font-family: "SF Mono", Monaco, "Cascadia Code", "Courier New", monospace;
  font-size: 13px;
  background: hsl(var(--muted) / 0.5);
  padding: 12px;
  border-radius: 6px;
  margin: 12px 0;
  overflow-x: auto;
}

.trace-step-body code {
  font-family: "SF Mono", Monaco, "Cascadia Code", "Courier New", monospace;
  font-size: 13px;
  background: hsl(var(--muted) / 0.5);
  padding: 2px 6px;
  border-radius: 3px;
}

.trace-step-body pre code {
  background: none;
  padding: 0;
}
```

**Tool Results:**
Tool call results may contain structured data, JSON, or plain text. Format based on content type:

```css
.tool-result {
  margin-top: 12px;
  padding: 12px;
  background: hsl(var(--muted) / 0.3);
  border-radius: 6px;
  font-size: 13px;
  border-left: 3px solid hsl(200 70% 50%);
}

.tool-result.json {
  font-family: "SF Mono", Monaco, monospace;
  white-space: pre-wrap;
  overflow-x: auto;
}

.tool-result.error {
  border-left-color: hsl(var(--destructive));
  background: hsl(var(--destructive) / 0.05);
}
```

**Long Content Handling:**

- **Thinking text:** No truncation, full text shown
- **Tool results:** Show first 500 characters with "Show more" button if longer
- **Titles:** Truncate with ellipsis at 60 characters

```css
.truncate-title {
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.expand-button {
  margin-top: 8px;
  padding: 6px 12px;
  font-size: 12px;
  color: hsl(var(--primary));
  cursor: pointer;
  border: 1px solid hsl(var(--border));
  border-radius: 6px;
  background: transparent;
  transition: all 0.15s;
}

.expand-button:hover {
  background: hsl(var(--muted));
  border-color: hsl(var(--primary) / 0.3);
}
```

#### Accessibility

The agent trace modal is fully accessible via keyboard and screen readers:

**ARIA Attributes:**

```html
<!-- Modal overlay -->
<div
  id="traceModal"
  role="dialog"
  aria-modal="true"
  aria-labelledby="trace-modal-title"
  aria-describedby="trace-modal-desc"
>
  <!-- Modal header -->
  <div class="modal-header">
    <div>
      <h2 id="trace-modal-title">Agent Session</h2>
      <div id="trace-modal-desc" class="modal-meta">Ariadne • 6.3s • 5 steps</div>
    </div>

    <!-- Action buttons with labels -->
    <button class="modal-action-btn" aria-label="Trace preferences" aria-pressed="false">
      <!-- Settings icon -->
    </button>

    <button class="modal-action-btn" aria-label="Close dialog">
      <!-- Close icon -->
    </button>
  </div>

  <!-- Trace steps -->
  <div class="modal-body" role="region" aria-label="Trace steps">
    <div class="trace-step" role="article" aria-labelledby="step-1-type">
      <div class="trace-step-header">
        <span id="step-1-type" class="trace-step-type thinking"> Thinking </span>
      </div>
      <div class="trace-step-body">
        <!-- Step content -->
      </div>
    </div>
  </div>
</div>
```

**Keyboard Navigation:**

- **TAB:** Move focus through interactive elements (settings, close, source links, expand buttons)
- **SHIFT+TAB:** Move focus backward
- **ENTER/SPACE:** Activate focused button
- **ESC:** Close modal
- **Arrow keys:** Scroll modal content (native browser behavior)

**Focus Management:**

```javascript
function openModal(highlightStepIndex) {
  const modal = document.getElementById("traceModal")
  const closeButton = modal.querySelector('.modal-action-btn[aria-label="Close dialog"]')

  // Store previously focused element
  const previouslyFocused = document.activeElement
  modal.dataset.previousFocus = previouslyFocused

  // Show modal
  modal.classList.add("active")
  modal.style.display = "flex"

  // Move focus to close button
  closeButton.focus()

  // Trap focus within modal
  modal.addEventListener("keydown", trapFocus)
}

function closeModal() {
  const modal = document.getElementById("traceModal")

  // Remove focus trap
  modal.removeEventListener("keydown", trapFocus)

  // Hide modal
  modal.classList.remove("active")
  modal.style.display = "none"

  // Restore focus to previous element
  const previouslyFocused = document.querySelector(`[data-id="${modal.dataset.previousFocus}"]`)
  if (previouslyFocused) {
    previouslyFocused.focus()
  }
}

function trapFocus(event) {
  const modal = document.getElementById("traceModal")
  const focusableElements = modal.querySelectorAll(
    'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
  )
  const firstFocusable = focusableElements[0]
  const lastFocusable = focusableElements[focusableElements.length - 1]

  if (event.key === "Tab") {
    if (event.shiftKey) {
      // SHIFT+TAB
      if (document.activeElement === firstFocusable) {
        event.preventDefault()
        lastFocusable.focus()
      }
    } else {
      // TAB
      if (document.activeElement === lastFocusable) {
        event.preventDefault()
        firstFocusable.focus()
      }
    }
  }
}
```

**Screen Reader Announcements:**

```html
<!-- Live region for status updates -->
<div role="status" aria-live="polite" aria-atomic="true" class="sr-only">
  <!-- Announce when sources expand/collapse -->
  Sources expanded. 3 sources available.
</div>

<!-- Hidden text for context -->
<span class="sr-only">Click to view full trace</span>
```

**Collapsible Sources:**

```html
<button class="sources-header" aria-expanded="false" aria-controls="sources-list-1">
  <div class="sources-title">
    Sources
    <span class="sources-count">3</span>
  </div>
  <!-- Chevron icon -->
</button>

<div id="sources-list-1" class="sources-list" hidden>
  <!-- Source items -->
</div>
```

#### Responsive Behavior

The trace modal adapts gracefully to different screen sizes:

**Desktop (> 1024px):**

```css
.modal-dialog {
  width: 90%;
  max-width: 800px;
  max-height: 85vh;
}
```

**Tablet (768px - 1024px):**

```css
@media (max-width: 1024px) {
  .modal-dialog {
    width: 95%;
    max-width: 700px;
    max-height: 90vh;
  }

  .trace-step {
    padding: 16px 20px;
  }

  .modal-header,
  .modal-footer {
    padding: 16px 20px;
  }
}
```

**Mobile (< 768px):**

```css
@media (max-width: 768px) {
  .modal-dialog {
    width: 100%;
    max-width: 100%;
    max-height: 100vh;
    height: 100vh;
    border-radius: 0;
    margin: 0;
  }

  .modal-overlay {
    padding: 0;
  }

  .trace-step {
    padding: 16px;
  }

  .modal-header,
  .modal-footer {
    padding: 12px 16px;
  }

  .modal-meta {
    font-size: 11px;
  }

  /* Stack modal header on mobile */
  .modal-header {
    flex-direction: column;
    align-items: flex-start;
    gap: 12px;
  }

  .modal-action-buttons {
    align-self: flex-end;
  }

  /* Sources section more compact */
  .sources-results {
    padding: 8px;
  }

  .source-item {
    padding: 8px;
  }
}
```

**Touch Interactions:**

- Touch-friendly button sizes (min 44×44px)
- No hover states on touch devices
- Swipe down to close (optional enhancement)

```css
@media (hover: none) {
  /* Hide hover hints on touch devices */
  .session-expand-hint,
  .message-trace-hint {
    display: none;
  }

  /* Always show context menu button on mobile */
  .message .message-menu-button {
    display: flex;
  }

  /* Increase touch target sizes */
  .modal-action-btn,
  .message-menu-button {
    min-width: 44px;
    min-height: 44px;
  }
}
```

#### Edge Cases & Error States

**Empty States:**

**No sources available:**

```html
<div class="sources-section">
  <div class="sources-header" aria-disabled="true" style="cursor: default; opacity: 0.5;">
    <div class="sources-title">
      <svg class="icon"><!-- Document icon --></svg>
      Sources
      <span class="sources-count">0</span>
    </div>
  </div>
  <div class="sources-empty">
    <p style="font-size: 12px; color: hsl(var(--muted-foreground)); margin-top: 8px;">No sources used for this step</p>
  </div>
</div>
```

**No thinking text (immediate tool call):**

```html
<div class="trace-step tool">
  <div class="trace-step-header">
    <span class="trace-step-type tool">
      <svg class="icon"><!-- Tool icon --></svg>
      Web Search
    </span>
    <span class="trace-step-time">0.3s</span>
  </div>
  <!-- No body content, just sources -->
  <div class="sources-section">
    <!-- Sources here -->
  </div>
</div>
```

**Error States:**

**Tool call failed:**

```css
.trace-step.error {
  background: hsl(var(--destructive) / 0.05);
  border-left: 3px solid hsl(var(--destructive));
}

.trace-step-type.error {
  background: hsl(var(--destructive) / 0.15);
  color: hsl(var(--destructive));
}
```

```html
<div class="trace-step tool error">
  <div class="trace-step-header">
    <span class="trace-step-type error">
      <svg class="icon"><!-- Alert icon --></svg>
      Tool Error
    </span>
    <span class="trace-step-time">0.1s</span>
  </div>
  <div class="trace-step-body">
    <div class="error-message"><strong>Error:</strong> Failed to fetch search results</div>
    <details style="margin-top: 8px; font-size: 12px; color: hsl(var(--muted-foreground));">
      <summary style="cursor: pointer;">Technical details</summary>
      <pre style="margin-top: 8px;">Network timeout after 5000ms</pre>
    </details>
  </div>
</div>
```

**Session failed:**

```html
<div class="agent-session-event failed">
  <div class="session-status-icon failed">
    <svg><!-- X icon --></svg>
  </div>
  <div class="session-info">
    <div class="session-status">Session failed</div>
    <div class="session-meta">2 steps • 1.2s • Error during execution</div>
  </div>
</div>
```

```css
.agent-session-event.failed {
  border-color: hsl(var(--destructive) / 0.3);
  background: hsl(var(--destructive) / 0.05);
}

.session-status-icon.failed {
  background: hsl(var(--destructive) / 0.15);
}

.session-status-icon.failed svg {
  color: hsl(var(--destructive));
}
```

**Long Content:**

**Very long thinking text:**

- Show full content initially
- If > 1000 characters, consider "See less" collapse option

**Very long tool results:**

```html
<div class="tool-result">
  <div class="tool-result-preview">
    <!-- First 500 characters -->
    Lorem ipsum dolor sit amet...
  </div>
  <button class="expand-button" onclick="expandContent(this)">Show full result (2,453 characters)</button>
</div>
```

**Source title truncation:**

```html
<div class="source-title" title="Very Long Article Title That Exceeds Normal Length And Needs To Be Truncated">
  Very Long Article Title That Exceeds Normal Length And...
</div>
```

```css
.source-title {
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* Show full title on hover */
.source-item:hover .source-title {
  white-space: normal;
  overflow: visible;
}
```

**Z-Index Management:**

```css
/* Ensure proper layering */
.modal-overlay {
  z-index: 1000; /* Above everything */
}

.message-context-menu {
  z-index: 100; /* Above messages */
}

.message-menu-button {
  z-index: 10; /* Above message content */
}

.tooltip {
  z-index: 1001; /* Above modal */
}
```

**Loading States:**

**Session still running:**

```html
<div class="agent-session-event running">
  <div class="session-status-icon running">
    <!-- Animated spinner -->
    <svg class="spinner" viewBox="0 0 24 24">
      <circle
        cx="12"
        cy="12"
        r="10"
        stroke="currentColor"
        stroke-width="3"
        fill="none"
        stroke-dasharray="31.4 31.4"
        stroke-linecap="round"
      >
        <animateTransform
          attributeName="transform"
          type="rotate"
          from="0 12 12"
          to="360 12 12"
          dur="1s"
          repeatCount="indefinite"
        />
      </circle>
    </svg>
  </div>
  <div class="session-info">
    <div class="session-status">Session running...</div>
    <div class="session-meta">3 steps so far • 4.2s elapsed</div>
  </div>
</div>
```

```css
.session-status-icon.running {
  background: hsl(var(--primary) / 0.15);
}

.session-status-icon.running svg {
  color: hsl(var(--primary));
  width: 14px;
  height: 14px;
}
```

---

## Animation & Motion

### Transitions

Default duration: `150ms` for micro-interactions, `200-300ms` for larger transitions.

```css
/* Micro-interactions */
transition: all 0.15s ease;

/* Panel/modal transitions */
transition: all 0.2s ease;

/* Glow/highlight effects */
transition: opacity 0.3s ease;
```

### Activity Indicators

Pulsing dot for recent activity:

```css
.activity-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: hsl(var(--primary));
}

.activity-dot.recent {
  animation: pulse 2s ease-in-out infinite;
}

@keyframes pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.4;
  }
}
```

### Reduced Motion

Respect user preference:

```css
.reduced-motion *,
.reduced-motion *::before,
.reduced-motion *::after {
  animation-duration: 0.01ms !important;
  animation-iteration-count: 1 !important;
  transition-duration: 0.01ms !important;
}
```

---

## Reference Files

### Kitchen Sink (Primary Reference)

`docs/design-system-kitchen-sink.html` - **THE** comprehensive reference with all components and patterns. This is a living document that should be updated whenever new UI components or patterns are added to the system.

The kitchen sink includes:

- Complete CSS implementation for all components
- Interactive examples with hover states
- Dark mode support
- All color variables and typography
- Working animations and transitions

**When to update:** Add new sections to the kitchen sink when implementing new UI patterns, components, or significant style changes. Keep it in sync with this document.

### Exploration Mockups

Historical explorations in `docs/references/mockups/sidebar-exploration/`:

| File                                     | Purpose                               |
| ---------------------------------------- | ------------------------------------- |
| `nav-19-hybrid-resizable.html`           | Thread panel system (final)           |
| `input-exploration-01.html`              | 8 input designs (Premium Glow chosen) |
| `input-exploration-02-interactions.html` | Popovers, toolbar, attachments        |
| `input-exploration-03-growth.html`       | Growth behavior, document editor      |
| `conversations-overview-01.html`         | Stream list redesign                  |
| `typography-exploration-01.html`         | Font comparison                       |
| `quick-switcher-01.html`                 | Quick switcher redesign               |

See `docs/references/mockups/sidebar-exploration/CLAUDE.md` for detailed decision logs.

---

## Implementation Checklist

When implementing a component, verify:

- [ ] Uses Space Grotesk font
- [ ] Follows color system (golden thread accents)
- [ ] Correct border radius (16px modals, 12px cards, 8-10px items)
- [ ] Appropriate spacing (multiples of 4px)
- [ ] Hover/focus states with gold accent
- [ ] Keyboard navigation support
- [ ] Respects reduced motion preference
- [ ] Dark mode tested
- [ ] **Kitchen sink updated** - Add new component/pattern to `design-system-kitchen-sink.html` with working example

---

## Drift Catalog (this doc vs. shipped code)

Every entry below is a place where the prose above does not match what
`apps/frontend/` actually renders. The "Reality" column is the code-of-record
as of this reconciliation pass; the "Source" column points at the file to
verify against if you doubt the entry. New drift discovered later should be
appended here, not silently fixed by rewriting the body.

### 1. Color tokens

| Claim above                                                           | Reality                                                                                                                                                                                            | Source                                                                                                                                               |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hsl(var(--success))` referenced throughout (trace, AI message theme) | **There is no `--success` token.** Real "success" greens are hard-coded: `hsl(142 76% 36%)` for the `message_sent` trace step, `text-emerald-600` / `hsl(152 69% 41%)` for the `bot` actor accent. | `apps/frontend/src/index.css`, `apps/frontend/src/lib/step-config.ts`, `apps/frontend/src/components/timeline/message-event.tsx` (`ACTOR_ROW_THEME`) |
| "Scratchpad" color = `hsl(280 60% 70%)` (purple)                      | `BADGE_CONFIG.scratchpad.color = "text-primary"` — gold, not purple.                                                                                                                               | `apps/frontend/src/components/layout/sidebar/config.ts`                                                                                              |
| Stalled = `hsl(45 70% 60%)` (yellow)                                  | Not used anywhere as a "stalled" signal. The closest live color is the gold urgency strip `hsl(45 100% 50%)` ("ai" activity).                                                                      | `apps/frontend/src/components/layout/sidebar/config.ts` (`URGENCY_COLORS`)                                                                           |
| Light-mode `--input` listed without `--ring` color callout            | Both `:root` and `.dark` define a `--ring` (`38 65% 50%` / `40 55% 55%`) — DESIGN.md §2.1 has the full table.                                                                                      | `apps/frontend/src/index.css`                                                                                                                        |

### 2. Mentions

The doc lists four mention variants (user / ai / channel / me). The shipped
renderer has **seven** trigger styles:

| Type        | Class                                                          | Source                                                |
| ----------- | -------------------------------------------------------------- | ----------------------------------------------------- |
| `user`      | `bg-[hsl(200_70%_50%/0.1)] text-[hsl(200_70%_50%)]`            | `apps/frontend/src/lib/markdown/mention-renderer.tsx` |
| `persona`   | `bg-primary/10 text-primary` (this is what the doc calls "ai") | same                                                  |
| `bot`       | `bg-green-500/10 text-green-600 dark:text-green-400`           | same                                                  |
| `broadcast` | `bg-orange-500/10 text-orange-600 dark:text-orange-400`        | same                                                  |
| `channel`   | `bg-muted text-foreground`                                     | same                                                  |
| `command`   | `bg-[hsl(280_60%_55%/0.15)] text-[hsl(280_60%_55%)] font-mono` | same                                                  |
| `me`        | `bg-[hsl(200_70%_50%/0.15)] text-primary font-semibold`        | same                                                  |

Base chip: `inline px-1 py-px rounded font-medium` (no `1px 4px` padding as the doc shows).

### 3. Messages — actor theming

The doc treats messages as **two kinds**: user and "AI". The shipped UI has
**four actor types** with distinct theming (`ACTOR_ROW_THEME` in
`apps/frontend/src/components/timeline/message-event.tsx`):

| Actor     | Row accent                                                                                                                                              | Name color         | Badge             |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ | ----------------- |
| `user`    | none                                                                                                                                                    | inherit            | none              |
| `persona` | gradient `from-primary/[0.06] to-transparent` + **inset shadow** `shadow-[inset_3px_0_0_hsl(var(--primary))]` (not `border-left`, not negative margins) | `text-primary`     | none              |
| `bot`     | emerald gradient + emerald inset stripe                                                                                                                 | `text-emerald-600` | `BOT` pill (10px) |
| `system`  | blue gradient + blue inset stripe `hsl(210 100% 55%)`                                                                                                   | `text-blue-500`    | none              |

Other corrections to "Message Styling":

- **Avatar size is 32px (comfortable) / 24px (compact)**, not 36px. Switched via `[data-message-display]` rules in `index.css`.
- The "negative margin / padding" overflow technique (`margin-left: -24px`) is not used; the accent is purely an inset shadow plus a row-level gradient background.
- The "context menu button" CSS in this doc (`position: absolute; top: 8px; right: 8px; …`) does not describe the shipped UI. The real per-message menu is a **Radix `DropdownMenu`** rendered by `MessageContextMenu` (desktop) or a vaul `MessageActionDrawer` (mobile). Auto-positioned; no hand-rolled `right: 40px` offsets.

### 4. Trace — step taxonomy

The doc lists **three** step types (Thinking / Tool / Response). The shipped
config (`apps/frontend/src/lib/step-config.ts`, `STEP_DISPLAY_CONFIG`) has
**twelve**:

`context_received` (Inbox) · `thinking` (Lightbulb) · `reconsidering` (RotateCcw) · `web_search` (Search) · `visit_page` (FileText) · `workspace_search` (Building2) · `github_access` (Github) · `linear_access` (CircleDot) · `message_sent` (MessageSquare) · `message_edited` (MessageSquare) · `tool_call` (Wrench) · `tool_error` (AlertTriangle).

Each has its own HSL triplet (hue/saturation/lightness) — there is no fixed
gold/blue/green palette; the color is computed per step. Full table in
[`DESIGN.md`](../DESIGN.md) §10.

### 5. Trace — dialog shell

The doc's `.modal-overlay` / `.modal-dialog` / focus-trap JS, "settings gear
toggles streaming" pattern, and ARIA scaffolding are **not** how the trace
dialog is implemented:

- The trace dialog uses `<ResponsiveDialog>` (Radix Dialog on desktop, vaul Drawer on mobile). ARIA/focus management comes from the primitives — there is no hand-rolled `trapFocus` function.
- The header includes a **lineage `<Select>`** (switch between superseded sessions) and a **`<StopResearchButton>`**, not a streaming-settings gear.
- Status states: `pending`, `running`, `completed`, `failed`, `deleted`, `superseded` — six, not just complete/failed/running.
- Source: `apps/frontend/src/components/trace/trace-dialog.tsx`.

### 6. Sidebar — urgency strip

The doc describes the urgency strip as a **6px column inside `.smart-sidebar-body`**
that scrolls with the content. The shipped implementation is different:

- The strip is **per-row**, not a separate column. Each `<StreamItem>` renders its own `<UrgencyStrip>` as a `w-1` left bar with `rounded-l-lg`.
- Width is Tailwind `w-1` (4px), not 6px.
- Quiet rows render `transparent`, not muted gray — the row owns the strip slot regardless.
- Source: `apps/frontend/src/components/layout/sidebar/stream-item.tsx`; colors in `apps/frontend/src/components/layout/sidebar/config.ts` (`URGENCY_COLORS`).

### 7. Sidebar — sections

Section labels and emojis are correct. Item caps and rules drift:

- Important: doc says "max 10 items". Shipped `TieredStreamSection` enforces `TIER_VISIBLE_LIMIT = 10` **across any tiered section**, with a `<MoreDivider>` (`"N more"` / `"less"`) toggle to reveal the rest — not a hard cap of 10.
- Recent: doc says "max 15 items, auto-expires after 7 days". Recency policy lives in the sort/scoring code, not as a literal cap of 15. Verify against `use-urgency-tracking.ts` and the section composition in `sections.tsx` before quoting numbers.
- Pinned: behavior described is broadly correct, but pin/unpin lives behind `SidebarActionMenu`/`SidebarActionDrawer`, not a "right-click to unpin" affordance.
- "Smart" vs "All" toggle exists in spirit — the actual section sets are `SMART_SECTIONS` (`important`/`recent`/`pinned`/`other`) and `ALL_SECTIONS` (`scratchpads`/`channels`/`dms`). See `sidebar/config.ts`.

### 8. Sidebar — collapse, width, hover margin

- "30px hover margin" is the value in `app-shell.tsx`'s own comment ("30px hover margin for 'magnetic' feel"). The doc says **15px** — drift.
- Three sidebar states: `collapsed` / `preview` / `pinned` — match the doc's intent, but the doc claims the collapsed state is a 6px strip. The collapsed state shows a column of urgency blocks driven by `urgencyBlocks` from `useSidebar()`; width matches `w-1` per row stacked, not a flat 6px bar.
- LocalStorage keys (`sidebar.width.preview`, `sidebar.width.pinned`) and 200/600 width constraints are **unverified** against `apps/frontend/src/contexts/sidebar-context.tsx`; do not quote them as ground truth without checking that file.

### 9. Composer / message input

- "Premium Glow" matches the spirit of `.input-glow-wrapper` in `index.css`, but the wrapper styles are defined globally (`::before` pseudo, 17px radius, opacity 0→1 on `:focus-within`) rather than as `.input-wrapper` / `.input-glow` pair shown in the doc.
- Height limits: shipped composer uses `min-h-[200px]` on the editor surface, and the container caps at `max-h-[380px]` on mobile when collapsed (`max-h-[75dvh]` when expanded). The "64px–380px total" range in the doc is roughly correct for mobile-collapsed; desktop has no hard cap of this form.
- Custom node types in flight (not in this doc): `mention`, `emoji`, `hardBreak`, `quoteReply`, `sharedMessage`, plus the standard `paragraph`/`heading`/`codeBlock`/`bulletList`/`orderedList`. See `apps/frontend/src/components/composer/message-composer.tsx`.
- "Floating selection toolbar" exists, but the actual desktop toolbar is `EditorToolbar` (always-visible row above the editor), not a hover-floating popover for bold/italic. Selection-quote behavior lives in `text-selection-quote.tsx`.

### 10. Code blocks

- Shipped code blocks render through **Shiki** with dual themes (`github-light` / `github-dark`) via `--shiki-light` / `--shiki-dark` CSS custom properties, switched by `.dark`. The `.code-block` / `.code-block-header` CSS in this doc describes a kitchen-sink mockup, not the shipped surface.
- ProseMirror `pre` styling is in `index.css`: `@apply bg-muted rounded-md p-4 my-2 font-mono text-sm overflow-x-auto`.

### 11. Quick switcher

- Modes match: `stream` / `command` / `search`, with prefixes `""` / `"> "` / `"? "`.
- Shortcuts: doc claims `Cmd+K`, `Cmd+Shift+K`, `Cmd+Shift+F`. Reality (`apps/frontend/src/lib/keyboard-shortcuts.ts`): the same three, **plus** `Cmd+F` in-stream search, `Cmd+.` settings, `Cmd+§` toggle sidebar, `Cmd+Shift+A` attachment explorer. (`mod+` is platform-agnostic in the source.)
- Styling specifics ("16px radius", subtle gradient `::before`, "pill mode tabs") are kitchen-sink intent — the shipped switcher renders inside `<ResponsiveDialog>` and uses `ModeTabs` + `RichInput`; if you need exact styling, read `apps/frontend/src/components/quick-switcher/`.
- Footer keyboard hints use the `.kbd-hint` utility class defined in `index.css`.

### 12. Top bar

- "44px height" is unverified — the topbar height in the shell is set by its content rather than a fixed `height: 44px` rule.
- **"Activity glow" / `stream-label-glow` / multi-persona color stripes / `glow-pulse` animation: not implemented.** This is aspirational. The actual loading affordance is `TopbarLoadingIndicator` — a single shimmer strip pinned to the topbar's bottom border, animated via `animate-topbar-shimmer`.

### 13. Thread panels

- "Max 3 panels" and "20% minimum width": shipped layout uses `MAX_PANEL_RATIO = 0.7` in `apps/frontend/src/hooks/use-panel-layout.ts` — that's a **max width ratio**, not a min, and is per-panel rather than a global panel count cap. A hard "3-panel" cap is not enforced by that file; the panel list comes from `useSearchParams().getAll("panel")` in `WorkspaceLayout`. Verify before quoting numbers.

### 14. Image gallery

The CSS-only mockup in this doc described `.image-preview` / "+N more overlay". The shipped surface is `apps/frontend/src/components/image-gallery.tsx` + `gallery/`, mounted via `MediaGalleryProvider`. Component layout, swipe behavior, and thumb strip are owned by that React tree — read the components rather than the CSS in this doc.

### 15. Inline AI message vs. trace navigation

The "AI message hover hint", "click message to open trace at response step", and "right: 40px context menu" CSS describe an early mockup. The shipped affordances:

- **Discuss-with-Ariadne / open-trace** is wired via `useDiscussWithAriadne()` and `useTrace()`, surfaced through `MessageContextMenu` / `MessageActionDrawer`. The interaction surface is the dropdown, not a hand-rolled CSS popover.
- The `TraceProvider` + `<TraceDialog />` pair handles both "open at top" and "open scrolled to step" — bidirectional navigation as described in spirit, but implemented via React context, not the JS snippets in this doc.

### 16. Accessibility / motion

- Reduced-motion class (`.reduced-motion`) is real and works as described.
- Font size / family overrides (`[data-font-size]`, `[data-font-family]`) match the doc.
- High-contrast mode (`.high-contrast`) is **not** mentioned in the doc above but exists in `index.css` — worth folding in next time this doc is rewritten.

---

### How to use this catalog

If you are about to implement or modify a surface mentioned in the prose
above, **read both the prose entry and any corresponding drift-catalog
entry**. If you are unsure, fall through to [`DESIGN.md`](../DESIGN.md) and
the code. When you fix drift in code, either retire the matching catalog
entry (and update the prose) or — if the doc is still useful as aspiration —
leave the entry and update its "Reality" column.
