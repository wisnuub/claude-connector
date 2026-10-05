# Design styles — award-site archetypes for builder pages

A field guide for turning "make it look like an Awwwards site" into concrete
decisions. Built from the 45 most recent Awwwards Sites of the Day (Sept–Oct
2026): their jury tags, palettes and highlighted interactions, plus 13 of them
sampled live and measured (fonts, sizes, tracking, libraries, motion).
How to build is in [BUILDING.md](BUILDING.md); motion classes are in
`tools/motion/`.

When someone asks for a style, pick **one** archetype, say which, and follow
its recipe. Mixing two usually produces the generic look you were trying to
escape.

---

## What every winner shares

These hold across all seven archetypes — they are the floor, not a style:

- **One idea per screen.** A hero says one thing in one huge line; sections
  don't compete.
- **Display type is enormous and tight.** Measured hero sizes 88–360px, tracking
  −2% to −5%, line-height 0.9–1.0. The family sets the weight: luxury went
  *thin* (220), graphic went *black* (700).
- **Restrained palette.** Most winners declare one or two colours. Brand
  colour is used as an accent, not a fill.
- **Smooth scroll is the baseline.** Lenis was present on 11 of 13 sampled
  sites (`m-smooth`).
- **Motion is choreographed, not decorative.** Jury-highlighted elements were
  mostly transitions (23), interactions (27), mouse (18), scroll (17) and
  loading screens (14). Everything enters; nothing just *is there*.
- **Tiny UI around huge type.** Nav, labels and buttons are small (12–16px),
  often mono or uppercase — the contrast with the headline is the design.

## Pick an archetype

| If the brief / client is… | Archetype |
|---|---|
| hotel, resort, real estate, wine/spirits, jewellery, architecture, high-ticket services | **1. Luxury editorial** |
| consumer brand, entertainment, food & drink, education, community, youth | **2. Bold graphic** |
| consultancy, recruitment, studio, law/finance that wants to feel modern | **3. Minimal Swiss** |
| product launch, deep tech, automotive, space/defence, gaming | **4. Cinematic 3D** |
| SaaS, AI, fintech, developer tools, startups | **5. Product tech** |
| designer/artist portfolio, culture, festival, "make it different" | **6. Abstract experimental** |
| trades, industrial, logistics, corporate, healthcare, government | **7. Corporate premium** |

"Graphic design site" → 2 (or 3 if they want restraint). "Simple site" → 3 or 7.
"Aesthetic with abstract structure" → 6.

---

## 1. Luxury editorial
*Refs: Tengile Malamala, White Desert, Sobha Privy Collection, ERA Residence.*

- **Layout:** vast negative space; headline lines **offset** (second line
  indented under the first's end); content in a narrow column right of centre;
  faint full-height column grid lines; full-bleed photography between text
  screens.
- **Type:** thin high-contrast serif or light display caps (PP Fragment-like,
  weight 200–300) at 100–160px, wide tracking on labels; body in a refined
  serif or light grotesk.
- **Colour:** one muted ground (greige `#8A8780`, bone `#FBF8F6`, ink navy
  `#1F2A44`) + one deep accent from the brand.
- **Imagery:** large, quiet, editorial photography; no icons.
- **Motion:** `m-split` on every heading (slow, 1.2–1.4s), `m-fill` on the
  statement paragraph (signature move — words fill as you scroll),
  `m-parallax` on photos, `m-clip` on the hero image, `m-smooth`. Small square
  buttons with a separate arrow box.
- **Builder notes:** straightforward in both builders. Grid lines = a fixed
  `background-image: linear-gradient` stripe on the page wrapper.
- **Don't:** rounded pill buttons, bright colours, more than two typefaces.

## 2. Bold graphic
*Refs: Trevor Noah, Aardvark Book Club, Decathlon Yestalgia, Illoca, Warm & Fuzzy.*

- **Layout:** big rounded containers (24–48px radius) as colour blocks; cards
  rotated a few degrees; overlapping layers; sticker-like cut-out photos with a
  white outline; pill tags everywhere.
- **Type:** chunky black grotesk (Degular / Die Grotesk-like, 700–900) at
  120–360px, tight; a **handwritten script** accent for asides.
- **Colour:** 3–5 saturated colours on purpose (pink, yellow, cyan, violet),
  dark navy or black text.
- **Imagery:** cut-outs, illustration, collage, product shots on flat colour.
- **Motion:** `m-stagger` with rotation on card grids, `m-marquee` of tags or
  titles, `m-magnetic` on buttons, playful hovers (scale + rotate).
- **Builder notes:** very achievable. Rotation and colour per card via native
  Transform/Background controls. Cut-out photos need transparent PNGs.
- **Don't:** thin type, greys, large photographic heroes.

## 3. Minimal Swiss
*Refs: Aspen Search, Boc.Studio, Gil Huybrecht, Paul Kalkbrenner, Squarespace Foundations.*

- **Layout:** the screen **divided into panels by hairline borders**; strict
  grid; one giant word set left; small text blocks in panels; a live detail
  (clock, coordinates, location) in the header.
- **Type:** one neo-grotesk (Suisse / PP Mori / Inter Tight-like) at two
  sizes only — huge and small; mono uppercase for labels and buttons.
- **Colour:** white/near-black + **one** electric accent block (mint, orange).
- **Imagery:** halftone/dithered or monochrome treatments; logos in a marquee.
- **Motion:** quiet. `m-reveal` on panels, `m-marquee` for the client-logo
  strip, hover states that invert a panel. Minimal `m-split`.
- **Builder notes:** easiest archetype in both builders — it's mostly borders,
  grid and type. Halftone = CSS `mask-image` with a dot pattern, or pre-treated
  images.
- **Don't:** shadows, gradients, rounded corners, decorative motion.

## 4. Cinematic 3D
*Refs: Edolus, USAvionix, L.I.S.A., Moto Finance, Colonia Zacamil.*

- **Layout:** full-screen black canvas; one 3D object/scene per chapter;
  text overlaid small and wide-tracked; chaptered scroll storytelling;
  **preloader with a percentage**.
- **Type:** geometric or stencil caps, spaced; little body copy.
- **Colour:** black + white, one light/glow colour.
- **Imagery:** real-time WebGL/Three.js scenes.
- **Builder notes:** the real thing needs custom WebGL, which is outside what
  a page builder should carry on a client site. Achievable approximation:
  pre-rendered video or image sequences as section backgrounds, `m-clip`,
  `m-split` with long durations, scroll-scrubbed `m-parallax-bg`, a short
  logo preloader. Say plainly that it is an approximation.
- **Don't:** promise interactive 3D in a builder.

## 5. Product tech
*Refs: Cerebrium, Sharplink, Butter, Why Zero.*

- **Layout:** dark hero with one abstract 3D render or gradient object;
  headline bottom-left; short description + two buttons bottom-right; nav in a
  boxed pill; then bento grids of UI screenshots and metrics.
- **Type:** light-weight grotesk (ABC Favorit / Archivo-like, 300–400) at
  80–90px, tight; **mono uppercase** for nav and buttons.
- **Colour:** near-black or deep navy + one neon accent (pink, electric blue,
  green); accent applied to 1–2 words of the headline.
- **Imagery:** product UI, data visualisation, rendered abstract shapes.
- **Motion:** `m-split`, `m-count` on metrics, `m-stagger` bento, `m-parallax`
  on the render, `m-magnetic` CTAs.
- **Builder notes:** achievable; use a rendered image/video for the hero
  object.

## 6. Abstract experimental
*Refs: bleibtgleich, Gionatan Nese, Léo Parpeix, LxL Creative.*

- **Layout:** **asymmetric editorial grid** with vertical rules; text blocks
  placed off-centre at different column starts; **ghost type** (huge, light
  grey words in the corners); abstract blob or organic shapes; lots of white.
- **Type:** one grotesk (Akzidenz-like) at 80–100px, very tight (−5%),
  stacked short lines.
- **Colour:** black on white; colour arrives through images or a single
  chromatic effect.
- **Motion:** `m-split`, `m-horizontal` galleries, `m-fill`, cursor
  interactions (`m-magnetic`), distortion effects where custom code is allowed.
- **Builder notes:** layout is achievable with absolute positioning and
  per-breakpoint offsets; keep mobile as a clean single column. Heavier
  distortion/WebGL effects are out of scope.
- **Don't:** symmetric centred layouts, stock photography.

## 7. Corporate premium
*Refs: Realevate, Seasats, United Carriers, CoMinVi — and the two builds in BUILDING.md.*

- **Layout:** clean and centred-to-left; a **kinetic headline** (giant word
  marquee, sometimes with a photo inset *inside* the line of type — Realevate);
  stat bands; logo strips; photo cards with gradient overlays; dark CTA card.
- **Type:** confident grotesk (Google Sans / Inter Tight-like, 500–700) or the
  brand face; serif italic accents for warmth.
- **Colour:** brand primary + neutral grounds + one accent taken from the
  photography.
- **Motion:** `m-split` headings, `m-count` stats, `m-stagger` grids,
  `m-marquee` (services, sectors, clients), `m-parallax`/`m-clip` imagery,
  `m-smooth`. Optional soft logo preloader.
- **Builder notes:** fully achievable; this is the default for most client
  sites.

---

## Signature moves → how to build them

| Move | Seen on | Builder recipe |
|---|---|---|
| Line-by-line masked headline | almost all | `m-split` |
| Words fill as you scroll | White Desert | `m-fill` |
| Giant kinetic word marquee | Realevate, Boc | `m-marquee` on a huge heading; for an inset photo, put an image module between two text spans in the track |
| Pinned horizontal gallery | portfolios, galleries | `m-horizontal` on the row/container; give children fixed widths (30–45vw) |
| Magnetic buttons | 18 of 45 had mouse interactions | `m-magnetic` |
| Stat count-up | product, corporate | `m-count` (keeps the real figure in the HTML) |
| Preloader with % | Edolus, Seasats | logo + counter overlay that fades out on load; keep it under 1.5s and skip it on repeat visits |
| Visible column grid | White Desert, Aspen | fixed background stripes / hairline borders |
| Ghost type in corners | bleibtgleich | absolutely positioned huge light-grey text, `aria-hidden` |
| Cut-out sticker photos | Trevor Noah | transparent PNG + `filter: drop-shadow` white outline |
| Halftone imagery | Aspen | pre-treated images or CSS mask |
| Offset headline lines | Tengile | second line as its own span with `padding-left` |
| Mono uppercase UI | product, Swiss | one mono face for nav/labels/buttons only |

Out of scope in a builder on a client site: real-time WebGL scenes, shader
distortion, page-transition routers (Barba), sound design. Approximate them, and
say so.
