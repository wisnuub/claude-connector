# Building high-quality pages in Divi and Elementor

How to get builder pages to the standard of a hand-built Next.js/Framer site,
on a client's live WordPress site, without risking it. Written for Claude; the
gotchas behind each rule are in [KNOWLEDGE.md](KNOWLEDGE.md), and the Divi 5
write mechanics are in [DIVI5.md](DIVI5.md).

Builder pages look generic for design reasons, not builder reasons: one heading
size everywhere, default buttons, grey card grids, no section rhythm, stock
icons instead of the client's photography. Every fix below is a design decision
expressed through native modules.

---

## 1. Safety rules on a client site

Usually there is no cPanel. A fatal error or a broken global setting can take
the site down with no way back in, so:

- **Build on a new page. Never edit an existing page, menu, Theme Builder
  template, global preset, global colour, kit setting or sitewide stylesheet.**
  Divi presets and Elementor kit settings restyle every page that uses them.
- **Scope all CSS to the new layout.** One wrapper class on every top-level
  section, every selector under it. Nothing can then leak into the header,
  footer or other pages.
- **Preview without publishing publicly, in this order:** create as draft →
  set `post_password` → set Yoast noindex (`_yoast_wpseo_meta-robots-noindex` = 1)
  → publish. Check `nav_menu_options.auto_add` is empty first so the page can't
  land in a menu. Verify anonymously that only the password form is served.
- **Hand over as a library template** (`wp_divi_library_save`, or
  `wp_elementor_data_set` on an `elementor_library` post). Templates affect
  nothing until someone loads them, and neither builder exposes them publicly.
- **Don't deploy plugin code to a client site as part of design work.** Ship
  tooling changes through a release instead.
- **Real content only.** Copy, numbers, names and quotes come from the
  client's existing pages. Read animated counters after they finish animating
  — a scraped `0` or a guessed label is a false claim on a real business.

## 2. Discover before designing

```
wp_status                         # builder + version, acting_as.unfiltered_html
wp_elementor_kit / theme colours  # the brand's own tokens
wp_divi_data_get / wp_elementor_data_get on the home page   # real structure + copy
wp_page_screenshot(url) of home + an inner page, desktop and mobile
```

- **Header behaviour decides the hero.** Measure it: is it fixed/absolute,
  how tall at desktop and phone, are its links light or dark? A transparent
  header with white links needs a dark hero; dark links need a light one.
  Mobile headers are often 2× taller.
- **Look at the media library as a contact sheet**, not a filename list —
  render the images into a grid and pick by eye. Prefer the client's own
  project/team photography over stock. Use attachment IDs so the builder serves
  resized files (originals can be 15MB+).
- **Find what the theme injects** around the content (page-title banners,
  breadcrumbs, sidebars) and how pages that don't show it switch it off.

## 3. The design system

First pick a style archetype from [DESIGN-STYLES.md](DESIGN-STYLES.md) (luxury
editorial, bold graphic, minimal Swiss, cinematic 3D, product tech, abstract
experimental, corporate premium) and say which one you chose. Then write tokens
down before building. Both reference builds used the same recipe:

| Token | Rule |
|---|---|
| Palette | Brand dark + one warm/neutral ground + **one** accent. The accent can come from the photography (hi-vis orange in a trades site). Check accent-on-white contrast; use a deeper shade for text. |
| Display type | One display face at 2–3 weights, tight tracking (−0.03 to −0.045em), line-height ~1.0. Keep the brand face if there is one. An italic serif accent on 1–3 words per heading adds character. |
| Scale | H1 ~ 7vw (112px max desktop, 44–46px phone); H2 ~ 64px / 34px; body 17px / 1.65. Set every breakpoint explicitly. |
| Eyebrows | Small label + short rule above each heading. Match the brand voice (`who we are.`). |
| Rhythm | 120–140px section padding desktop, 72px phone; one container width (~1320px); alternate light, off-white and dark grounds. |
| Components | Pill buttons with an arrow and hover lift; underlined text links; 20–24px radius on media; hairline dividers instead of boxes. |

Section recipes that read as "designed": editorial hero (huge type + rounded
media card or full-bleed video with gradient overlay) · stat band with big
numbers · split intro (heading left, copy right) · numbered list beside a
sticky photo · bento photo cards linking to services · statement over
photography · portrait grid · values cards · dark CTA card.

## 4. Build with the generators

`tools/divi5.mjs` and `tools/elementor.mjs` build the markup from plain JS, so
it can't be malformed. Generate, write, screenshot, repeat.

### Divi 5

- Native modules only: section/row/column/text/button/image. Headings are real
  `<h1>`/`<h2>` inside a Text module.
- Put the stylesheet in **one Code module inside the layout** (`code()` +
  `minifyCss()`), so it travels with the library template. One line, so
  wpautop can't break it.
- **Specificity:** Divi's own button rules use `body #page-container
  .et_pb_section …`, and sites often load a sitewide stylesheet with `#et-boc`
  selectors. Prefix every rule `html body #et-boc .x.x.x` (wrapper class
  repeated) — that clears both without `!important` wars.
- A Button module's CSS class lands on the `<a>`, inside
  `.et_pb_button_module_wrapper`; columns are flex columns, so set
  `width:auto` on wrappers to put buttons side by side.
- The Text module auto-paragraphs: an inline `<span>` at the start gets wrapped
  in `<p>`. Position things absolutely rather than relying on grid placement of
  the module's children.
- Use `wp_divi_modules_list({ name })` for attribute groups; the CSS class
  lives at `module.advanced.htmlAttributes`.

### Elementor

- Flexbox Containers + core widgets (Heading, Text Editor, Button, Image).
  Set typography, colour, spacing and radius **in each widget's settings**, at
  every breakpoint, so the client edits them in the panel.
- Shared extras (eyebrow rule, hover motion, accent spans) go in the top
  container's Elementor Pro Custom CSS — it travels with the template.
- Traps (all verified): image widgets need `image.url` even with `image.id`;
  overlays need `background_overlay_opacity: 1` or render at 50%; nested
  containers default to 10px padding — zero it; percentage widths plus gaps
  overflow — use slightly smaller widths with `_flex_size: 'grow'`; use the
  native overlay over a background video, not CSS on Elementor internals.
- Page settings (`hide_title`, theme switches) and `page_template` go through
  `wp_elementor_data_set` in the same call.

## 5. Motion

Static builder pages are the last visible gap to a Next.js/Framer build. The
reference sites move in a handful of specific ways, and `tools/motion/` gives
each one a class you put on a native module (Divi: CSS Class field;
Elementor: Advanced → CSS Classes):

| Class | Effect | Typical use |
|---|---|---|
| `m-split` | headline rises line by line out of a mask | every H1/H2, long pull quotes |
| `m-reveal` | fade + rise into view; `m-d1`…`m-d6` add 0.1s steps | eyebrows, body copy, links |
| `m-stagger` | each direct child reveals in turn | card rows, columns, button groups, lists |
| `m-count` | first number counts up from 0 | stat bands |
| `m-parallax` | image drifts inside its frame | feature photos, sticky images |
| `m-parallax-bg` | background image drifts | statement sections, CTA cards |
| `m-clip` | media opens from an inset clip as it enters | hero / feature media |
| `m-marquee` | content loops sideways, follows scroll direction | service words, client names |
| `m-fill` | statement words fill from faint to full while scrolling | one statement paragraph per page |
| `m-horizontal` | pins the parent section and slides the row sideways (≥900px) | galleries, project rows (fixed-width children) |
| `m-magnetic` | button drifts toward the cursor | primary CTAs |
| `m-pin` | holds a section still: with `m-fill` inside until every word has filled; with `m-steps` inside until every step has shown | statement sections, program/service lists |
| `m-steps` + `m-steps-media` | (desktop) list items activate one by one while pinned; the matching image crossfades in; stopping mid-crossfade glides to the next whole step. Hide media children 2+ in CSS so phones and no-JS show the first image. To make the image as tall as the list, stretch the row and give the media column `display:grid; grid-template-rows:minmax(0,1fr)` and the images `height:100%; object-fit:cover` | "what we do" lists, process steps |
| `m-smooth` | Lenis smooth scrolling for the page | put once, on the hero |

**Setup.** Self-host the libraries in `wp-content/uploads` with
`wp_files_fetch` (URLs in `tools/motion/loader.mjs` → `MOTION_FILES`) and write
`tools/motion/motion.js` next to them. Put `motionLoader(prefix)` in the
**first** module of the layout — a Divi Code module or an Elementor HTML widget —
so it travels with the library template and only runs on pages that use it.
It is class-gated, so moving the same snippet into Divi → Integration → Head
later (sitewide) changes nothing on pages without `m-*` classes. On a client
site, get explicit agreement before making it sitewide.

**Rules the runtime enforces — keep them if you extend it:**
- Content is only hidden while `html.m-js` is set; the runtime clears it once
  initial states are applied, and a 3s timeout clears it if the scripts never
  load. Reveal with `fromTo(... → autoAlpha:1)`, never `from()` — `from()`
  reads the hidden opacity as its end value.
- `prefers-reduced-motion`: everything visible, nothing moves.
- Counters keep the real figure in the HTML. Prefer `m-count` over Elementor's
  Counter / Divi's Number Counter widgets: those render `0` in the page source
  and animate to the value in JS, so search engines, link previews and no-JS
  visitors see "0".
- Pins are centred in the space below a fixed header, measured after scrolling
  (headers often shrink once scrolled). The runtime publishes that height as
  `--m-header` on `<html>`; a full-screen section uses `min-height:100svh;
  padding-top:calc(var(--m-header, 104px) + 24px)` so its content clears the
  header. The pinned block must fit in the viewport minus the header at laptop
  sizes (1024×768) — tighten its spacing there or the last item is cut off.
- SplitText reverts after the reveal, so the final DOM is the original markup.
  Line masks are padded so descenders aren't clipped at tight line-heights.

**Verify motion like this**, not with a single static screenshot: load the
page, capture frames at ~0.4/0.8/1.2/2.5s (the hero should be mid-reveal, then
complete), scroll the whole page, then assert no element with an `m-*` class is
still hidden and there are no console errors. Test locally with the page's DOM
first (`tools/motion` has no build step), then live.

## 6. Verify by looking

```
wp_page_screenshot({ id, password, full_page: true })
wp_page_screenshot({ id, password, device: "mobile", full_page: true })
wp_page_screenshot({ id, password, scroll_to: ".my-sticky-section" })
```

After every meaningful change, at both widths. When something looks wrong,
find the rule that won (computed style + matching rules) before changing CSS —
guessing at specificity wastes iterations. Full-page slices pin sticky elements
at their first position; check those with `scroll_to`. `broken_images` in the
response catches files that never loaded.

Then check the rest of the site is untouched: existing pages still return 200,
and on Divi `wp_divi_audit` is healthy.

## Checklist

- [ ] New page only; draft → password → noindex → publish; menu auto-add empty
- [ ] Tokens written down: palette, type scale, spacing, one accent
- [ ] All copy and figures taken from the client's own pages
- [ ] CSS scoped under one wrapper class (Divi) / native settings (Elementor)
- [ ] Desktop and mobile screenshots reviewed; nothing broken or overlapping
- [ ] Motion: m-* classes on native modules, loader in the first module, frames + full-scroll check passed
- [ ] Screenshot runs kept light on shared hosts (video is skipped by default) - repeated heavy runs trip per-IP throttling
- [ ] Saved as a library template; template not publicly reachable
- [ ] Existing pages still serve; Divi audit healthy
- [ ] Anything learnt the hard way → `wp_knowledge_add`
