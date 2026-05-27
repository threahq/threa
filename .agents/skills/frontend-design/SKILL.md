---
name: frontend-design
description: Create distinctive, production-grade frontend interfaces with high design quality. Use this skill when the user asks to build web components, pages, artifacts, posters, or applications (examples include websites, landing pages, dashboards, React components, HTML/CSS layouts, or when styling/beautifying any web UI). Generates creative, polished code and UI design that avoids generic AI aesthetics.
license: Complete terms in LICENSE.txt
---

This skill guides creation of production-grade frontend interfaces with strong aesthetic point-of-view. Implement real working code with care for typography, color, spacing, and motion.

The user provides frontend requirements: a component, page, application, or interface to build. They may include context about the purpose, audience, or technical constraints.

## Working Inside An Existing App vs. Greenfield

**Before anything else, figure out which mode you're in.** This determines almost every aesthetic choice.

### Mode A: Existing app codebase (default when the user already has a repo)

This is the common case for product work — adding a page, building a feature, restyling an existing surface. The app already has an aesthetic, and your job is to extend it, not to overwrite it.

**Do this first, before any design thinking:**

1. **Look for a design system doc.** Common locations: `docs/design-system.md`, `DESIGN.md`, `docs/design/`, `.agents/design.md`, a Storybook, or a kitchen-sink HTML reference. Read it. The fonts, colors, radii, spacing scale, and component vocabulary listed there are non-negotiable. The user may also mention "DESIGN.md once it's merged" or similar — check whether such a file is in flight on another branch before defaulting to your own taste.
2. **Open 2–3 existing pages / components** in the same area as what you're building (e.g. for a new settings page, open the existing settings + profile + workspace pages). Note: page hero shape, heading sizes, card radii, spacing rhythm, color usage, font weights. These are the patterns to match.
3. **Use the existing UI primitives.** If there's a `components/ui/` directory or a Shadcn install, those primitives ARE the design language. Don't introduce a parallel set of buttons / cards / inputs styled with one-off Tailwind.
4. **Match the existing typography stack.** If the app uses Space Grotesk or another sans-serif throughout, do not reach for serif fonts, italics, or display fonts to add "distinction." That reads as out-of-band, not designed.

**In existing-app mode, the design system takes precedence over the aesthetic guidelines in this skill.** Bold typography pairings, dramatic display headings, unexpected layouts, and editorial flourishes are inappropriate when the surrounding app is restrained and utilitarian. A new page that visually screams against its neighbors is a regression, not a triumph.

If the design system is silent on something the task needs (e.g. an empty state, a new card variant), extrapolate from the system's tone — small radii + neutral surfaces + a single accent color → your new piece does the same.

**Anti-patterns to avoid in existing-app mode:**
- Adding a serif/italic accent word to a heading that the rest of the app would never style this way ("Labels *catalog.*", "Workspace *settings.*"). Even if it looks elegant in isolation, it's a foreign aesthetic.
- Oversized page heros (`text-4xl`/`text-5xl` titles, multi-line eyebrow + title + subtitle) in apps whose existing pages use a tight `h-12` header with an `h1 font-semibold` at body size.
- Eyebrow text (uppercase tracking-widest `text-[10px]`) sprinkled throughout when no other page in the app uses eyebrows.
- Importing a Google Font when the app already has a font loaded globally.
- Picking a "tone" (editorial, brutalist, retro, etc.) and applying it to a product surface whose existing tone is "functional + warm".

### Mode B: Greenfield / standalone artifact

This is the case when the user asks for a landing page from scratch, a poster, a one-off demo, a hackathon prototype, or anything with no surrounding visual context. Here the aesthetic guidelines below apply in full — commit to a direction, pick distinctive type, and execute boldly.

The rest of this document is mostly written for Mode B. Read it through that lens.

## Design Thinking (greenfield)

Before coding, understand the context and commit to a clear aesthetic direction:
- **Purpose**: What problem does this interface solve? Who uses it?
- **Tone**: Pick an extreme: brutally minimal, maximalist chaos, retro-futuristic, organic/natural, luxury/refined, playful/toy-like, editorial/magazine, brutalist/raw, art deco/geometric, soft/pastel, industrial/utilitarian, etc. There are so many flavors to choose from. Use these for inspiration but design one that is true to the aesthetic direction.
- **Constraints**: Technical requirements (framework, performance, accessibility).
- **Differentiation**: What makes this UNFORGETTABLE? What's the one thing someone will remember?

**CRITICAL**: Choose a clear conceptual direction and execute it with precision. Bold maximalism and refined minimalism both work - the key is intentionality, not intensity.

Then implement working code (HTML/CSS/JS, React, Vue, etc.) that is:
- Production-grade and functional
- Visually striking and memorable
- Cohesive with a clear aesthetic point-of-view
- Meticulously refined in every detail

## Frontend Aesthetics Guidelines (greenfield)

Focus on:
- **Typography**: Choose fonts that are beautiful, unique, and interesting. Avoid generic fonts like Arial and Inter; opt instead for distinctive choices that elevate the frontend's aesthetics; unexpected, characterful font choices. Pair a distinctive display font with a refined body font.
- **Color & Theme**: Commit to a cohesive aesthetic. Use CSS variables for consistency. Dominant colors with sharp accents outperform timid, evenly-distributed palettes.
- **Motion**: Use animations for effects and micro-interactions. Prioritize CSS-only solutions for HTML. Use Motion library for React when available. Focus on high-impact moments: one well-orchestrated page load with staggered reveals (animation-delay) creates more delight than scattered micro-interactions. Use scroll-triggering and hover states that surprise.
- **Spatial Composition**: Unexpected layouts. Asymmetry. Overlap. Diagonal flow. Grid-breaking elements. Generous negative space OR controlled density.
- **Backgrounds & Visual Details**: Create atmosphere and depth rather than defaulting to solid colors. Add contextual effects and textures that match the overall aesthetic. Apply creative forms like gradient meshes, noise textures, geometric patterns, layered transparencies, dramatic shadows, decorative borders, custom cursors, and grain overlays.

NEVER use generic AI-generated aesthetics like overused font families (Inter, Roboto, Arial, system fonts), cliched color schemes (particularly purple gradients on white backgrounds), predictable layouts and component patterns, and cookie-cutter design that lacks context-specific character.

Interpret creatively and make unexpected choices that feel genuinely designed for the context. No design should be the same. Vary between light and dark themes, different fonts, different aesthetics. NEVER converge on common choices (Space Grotesk, for example) across generations.

**IMPORTANT**: Match implementation complexity to the aesthetic vision. Maximalist designs need elaborate code with extensive animations and effects. Minimalist or refined designs need restraint, precision, and careful attention to spacing, typography, and subtle details. Elegance comes from executing the vision well.

Remember: Claude is capable of extraordinary creative work. Don't hold back, show what can truly be created when thinking outside the box and committing fully to a distinctive vision — *as long as that vision belongs in the surrounding app.* If you're in Mode A, the most distinctive thing you can do is execute the existing system flawlessly.
