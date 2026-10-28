/** Block styling shared by every rich editor surface; each caller adds its own sizing and font size. */
export const EDITOR_CONTENT_CLASS = [
  "[&_p]:my-0 [&_p]:min-h-[1.5em]",
  "[&_ul]:my-1 [&_ul]:pl-5 [&_ol]:my-1 [&_ol]:pl-5",
  "[&_li]:my-0 [&_li]:pl-0.5",
  "[&_pre]:my-2 [&_pre]:rounded-md [&_pre]:bg-muted [&_pre]:p-3",
  "[&_pre_code]:bg-transparent [&_pre_code]:p-0",
  "[&_blockquote]:my-2 [&_blockquote]:border-l-2 [&_blockquote]:border-muted-foreground/30 [&_blockquote]:pl-4 [&_blockquote]:italic",
  "[&_h1]:text-xl [&_h1]:font-bold [&_h1]:my-2",
  "[&_h2]:text-lg [&_h2]:font-semibold [&_h2]:my-1.5",
  "[&_h3]:text-base [&_h3]:font-semibold [&_h3]:my-1",
  "focus:outline-none",
].join(" ")
