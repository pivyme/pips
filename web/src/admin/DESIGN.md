# The Instrument: a molded dark dashboard design system

This is the design language of the PIPS admin dashboard, written so it can be lifted into another
project without the surrounding product. Every value here is the real value shipped in
[`admin.css`](./admin.css), [`components/primitives.tsx`](./components/primitives.tsx) and
[`../styles.css`](../styles.css). Copy the blocks verbatim, they are not illustrations.

**The feel.** Pure black canvas. Panels are molded plastic sitting on it, not luminance steps: they
have a lit top edge, a shaded bottom, and a hard lip underneath. Controls are machined hardware, keys
you press and grooves things sink into. One amber accent points, green/red state facts, everything
else is four tiers of grey. Type is a friendly geometric sans over mono uppercase micro-labels, and
every number is tabular so columns align on their own.

**The posture.** Dense, desktop-first, tabular. It is an instrument you read, not a page you browse.
Panels sit shoulder to shoulder, rows are 38px, and the whitespace budget goes into the gaps between
groups instead of the padding inside them.

If your dashboard could pass for any other dark admin template, the material model is the thing that
went missing. Section 1 is that model. Everything after it is that model applied.

---

## 0. Port it

Three files, two of them optional.

| Take | For | Notes |
|---|---|---|
| `admin.css` | The whole 2D system: tokens, panels, tables, badges, buttons, nav | Self-contained, one import |
| The `.hw3d-*` block in `styles.css` (L571-887) | The 3D hardware kit: keys, sockets, slide toggle | Needs `--ease-out-quart` defined |
| `Hardware3D.tsx` | Thin React wrappers over `.hw3d-*` (+ the fader, which is inline-styled) | Strip `haptic()` if you have no haptics |
| `components/primitives.tsx` | Panel, Metric, Badge, Segmented, the four states, four hand-rolled charts | Depends on lucide-react and a `cnm()` classname merger |

```tsx
// 1. Import the stylesheet from your shell, not globally. It is scoped, keep it that way.
import './admin.css'

// 2. Put data-admin on the root. Tokens resolve inside it and nowhere else.
<div data-admin className="flex min-h-screen">…</div>
```

**Dependencies.** Tailwind (utilities only, the design lives in the CSS classes), `lucide-react` for
icons at `strokeWidth` 2.3-2.6, and the Gabarito variable font. No chart library, no UI kit, no
animation library. Swap Gabarito for any geometric sans with real tabular figures and nothing else
changes.

**What is PIPS-specific and should be cut or swapped.** `GameIcon`, the brandmark letter `P`, and the
domain nouns (plays, chips, sponsor wallet). The amber `#ffc016` is our brand, it is the one token
worth re-picking. Everything else is generic.

**Two globals it leans on.** `--font-mono` (it falls back to `ui-monospace, monospace`, so it works
undeclared) and `--ease-out-quart: cubic-bezier(0.25, 1, 0.5, 1)` for the hardware kit. Declare the
second or the key presses go linear.

**One scoping caveat.** Tokens are scoped to `[data-admin]`, the `.a-*` class names are not. The
prefix makes collisions unlikely, and a component class that escapes the wrapper simply renders
uncolored, which is loud enough to catch.

---

## 1. The material model

This is the whole system. Four sections of tokens follow from it, and if you only internalize one
thing, make it this.

**There is one light source, directly above, slightly in front.** Nothing in the UI contradicts it.
That single constraint is what makes the surface read as molded rather than as a stack of grey
rectangles with borders.

From it come exactly three planes, and every element is one of them.

### Plane 1: raised (panels, keys, badges' parent surfaces)

A raised thing catches light on its top edge, falls into shadow at its bottom edge, and casts a hard
lip onto whatever is under it.

```css
/* The molded panel, four layers, in this order */
background: linear-gradient(180deg, #111110 0%, #0d0d0d 56%, #090909 100%), #0d0d0d;
border: 1px solid #1c1c1a;
box-shadow:
  inset 0 1px 0 #242422,             /* 1. the lit top edge, a hard 1px line */
  inset 0 -1px 4px rgb(0 0 0 / 0.46),/* 2. the shaded bottom, soft and inward */
  0 1px 0 #050505;                   /* 3. the lip, one hard pixel of drop */
```

Read the recipe as: **body gradient light-to-dark top-to-bottom, hard highlight inset at the top,
soft shadow inset at the bottom, hard 1px drop below.** The gradient carries the curvature, the top
inset is the specular hit on the edge, the bottom inset is the ambient occlusion where the face rolls
away, and the drop is where the part meets the case.

The gradient's midpoint at 56% is deliberate. A 50% stop reads as a linear ramp; pushing it past
halfway puts the falloff in the bottom third where the eye expects a curved surface to turn.

### Plane 2: sunken (input fields, segmented tracks, wells, toggle grooves)

A sunken thing inverts every term. Shadow at the top, light at the bottom, no drop at all.

```css
/* A groove: the exact inverse of the panel */
background: linear-gradient(180deg, #121316 0%, #1d1f22 100%); /* dark to light, inverted */
box-shadow:
  inset 0 2px 5px rgb(0 0 0 / 0.75),  /* the wall you are looking down into */
  inset 0 -1px 0 rgb(255 255 255 / 0.05); /* the far lip catching light */
```

Cheap version for text inputs where the depth only has to read at a glance:
`inset 0 1px 3px rgb(0 0 0 / 0.5)` over `#0a0a09`. One layer, still unmistakably recessed.

### Plane 3: flush (tables, text, the canvas)

Zero elevation. Separation comes from a hairline
(`border-bottom: 1px solid rgb(255 255 255 / 0.04)`) and nothing else. Most of the dashboard by area
is this plane, and that is what keeps the molded parts meaning something. If everything were molded,
nothing would be.

### The rules that keep it coherent

1. **Never mix planes on one element.** No panel with an inset top shadow, no input with a drop.
2. **Elevation is not a scale.** There is no elevation-1 through elevation-5. There is raised, sunken,
   and flush, and a thing is exactly one.
3. **Depth in pixels stays tiny.** The largest inset in the entire 2D system is 6px, the largest hard
   drop is 1px. Skeuomorphism goes wrong when it gets big. Restraint reads as machined, excess reads
   as a 2008 web app.
4. **One frame owns a real shadow.** The drawer overlay gets `0 24px 60px rgb(0 0 0 / 0.7)`. Exactly
   one thing in the app floats. Everything else is bolted down.
5. **Never use a border to fake elevation.** A raised thing has a `#1c1c1a` border because parts have
   edges, not because it needs the outline to be visible.

---

## 2. Color

Contrast figures are computed WCAG values against `#000`.

### Surfaces

Molded material, not luminance steps. The values are close together on purpose: separation is carried
by the shadow recipe, not by brightness.

| Token | Value | Use |
|---|---|---|
| `--a-bg` | `#000000` | The canvas. Always true black. |
| `--a-surface` | `#0d0d0d` | Panel body, the mobile nav strip |
| `--a-surface-2` | `#131312` | One step up |
| `--a-surface-hover` | `#191918` | Row hover, row selected, button hover |
| `--a-overlay` | `#161615` | Sticky group headers inside a drawer |
| `--a-border` | `#1c1c1a` | Every panel edge, every divider |
| `--a-border-strong` | `#2a2a27` | Interactive edges: buttons, inputs, the overlay |

### Text

Four tiers, and the fourth is not allowed to carry information.

| Token | Value | Contrast | Use |
|---|---|---|---|
| `--a-text` | `#f2f2f2` | 18.1 AAA | The thing you are scanning for: numbers, keys, titles |
| `--a-text-2` | `#b6b6b6` | 9.4 AAA | Table cells, body copy, runbooks |
| `--a-text-3` | `#8a8a8a` | 5.2 AA | Micro-labels, hints, column heads, secondary lines |
| `--a-text-muted` | `#5c5c5a` | 2.4 **fails AA** | Decorative only: idle icons, fingerprint hashes, vendor stack frames |

`--a-text-muted` failing AA is a deliberate, documented choice, not an oversight. It exists so a
row can hold something that is present but not being offered for reading. Put a value in it and you
have shipped an accessibility bug.

### Accent

One accent, the product's amber. It marks the active, the primary, and the reading. Nothing else.

| Token | Value | Use |
|---|---|---|
| `--a-accent` | `#ffc016` | 12.6 contrast. Active nav, p95, the bar that carries the reading |
| `--a-accent-dim` | `#d18a0a` | Deep edge on amber |
| `--a-accent-soft` | `rgb(255 192 22 / 0.12)` | Badge background |
| `--a-accent-glow` | `0 0 8px rgb(255 192 22 / 0.45)` | The lit-filament look on a filled bar |

Text on amber is warm near-black `#1a1200`, never white and never pure black. It reads as molded into
the plastic rather than printed on top.

### Status

| Token | Value | Contrast | Meaning |
|---|---|---|---|
| `--a-critical` | `#ff5a4d` | 6.1 | Down, loss, fatal, open bug |
| `--a-warn` | `#ffb224` | 11.4 | Degraded, unknown, needs attention |
| `--a-ok` | `#34d399` | 10.4 | Up, win, healthy, resolved |
| `--a-info` | `#5aa8ff` | 8.0 | Neutral information |

Each has a `-soft` twin at 13% alpha for badge and callout fills:
`--a-critical-soft: rgb(255 90 77 / 0.13)`, and the same for warn/ok/info.

**The 13% is the load-bearing number.** Full-strength text on its own hue at 13% is legible, keeps the
severity hue intact, and stays quiet. A solid red fill shouts, and once three things shout, red stops
meaning anything. That erosion is the first thing to go wrong on a surface like this.

### Neutral layers

| Token | Value | Use |
|---|---|---|
| `--a-tint` | `rgb(255 255 255 / 0.04)` | Icon wells, nav hover |
| `--a-track` | `rgb(255 255 255 / 0.05)` | Bar chart tracks |
| `--a-well` | `#080808` | The floor of an inset block. Darker than the canvas, which is what sells "cut into" |
| `--a-scrim` | `rgb(0 0 0 / 0.6)` | Drawer backdrop. No blur, it is a dashboard |

### The colour rules

1. **Colour means severity or direction. Never decoration, never category.** Five games in a table get
   five neutral bars, not five hues. If you cannot say what a colour asserts, it should be grey.
2. **An arrow is not a colour.** A rising count of warn-level errors renders as `↑` in `--a-text-3`,
   not in red. Direction and severity are separate channels and conflating them is how a dashboard
   starts crying wolf. See `Trend` in `primitives.tsx`.
3. **Never write a raw hex or `rgb()` in a component.** Every colour resolves through a token. A
   literal in a component file is a value nobody will ever find again when the palette moves, and it
   is exactly how a two-token severity scheme quietly becomes eleven colours. We enforce this with a
   check script (§13), not with review.
4. **A blank cell reads as zero.** If a value is not applicable, say `n/a` in `--a-text-muted` with a
   title explaining it. Never leave the cell empty.

---

## 3. Typography

```css
[data-admin] {
  font-family: 'Gabarito Variable', ui-sans-serif, system-ui, sans-serif;
  font-size: 13px;
  line-height: 1.45;
  font-variant-numeric: tabular-nums;  /* the single highest-impact line in this file */
  -webkit-font-smoothing: antialiased;
}
[data-admin] h1, [data-admin] h2, [data-admin] h3 {
  line-height: 1.15;
  letter-spacing: -0.015em;
}
```

**13px base.** Not 14, not 16. This is a surface where density is the feature, and 13 is the size at
which a six-column table still reads comfortably on a 1440px screen.

**Tabular numerals globally, set once at the root.** Every number aligns in its column without a
single per-component override. On a dashboard this is worth more than any other typographic decision.

**Negative tracking on headings only.** Geometric sans headings tighten well; body text at 13px does
not, leave it alone.

### The scale

| Class | Size / weight | Tracking | Use |
|---|---|---|---|
| `.a-page-title` | 26px / 800 | -0.015em | One per page, top left, same spot every page |
| `.a-metric` | 30px / 800 | -0.02em | The hero number in a stat tile |
| `.a-metric-sm` | 21px / 700 | -0.015em | Inline stats, funnel counts, p50/p95 |
| `.a-section-title` | 15px / 700 | -0.015em | Panel headers |
| body | 13px / 400 | 0 | Cells, copy |
| nav item | 13.5px / 600 | 0 | Rail links |
| hint / sub | 12px / 400 | 0 | The line under a metric, panel notes |
| `.a-label` | 10px mono / 600 | **0.14em** | The micro-label |
| `.a-mono` | 11.5px mono | -0.01em | Ids, addresses, route paths, event names |
| `.a-pre` | 11.5px mono / 1.6 | 0 | Stacks and raw text, `pre-wrap` + `break-word` |

### The micro-label

```css
.a-label {
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.14em;
  color: var(--a-text-3);
}
```

This is the signature move of the whole system: **a mono uppercase micro-label sitting over a big
tabular number.** It is what makes a stat tile read as an instrument readout rather than as a card
with a caption. Use it for stat labels, table column heads (at 0.12em, one notch tighter since they
repeat across a row), section headers, and definition-list terms.

The 0.14em tracking is not optional. At 10px, uppercase mono without generous tracking reads as a
smudge.

**Machine strings get mono.** Ids, hashes, wallet addresses, route paths, event names, worker names.
The reader is pattern-matching character shapes there, not reading words.

---

## 4. Geometry, spacing, layout

### Radii

```css
--a-radius:    16px;  /* panels, overlays */
--a-radius-sm: 10px;  /* wells, callouts, segmented tracks */
--a-radius-xs:  7px;  /* buttons, inputs, nav items, segment cells */
```

Three values, and note how tight they are compared to a consumer surface. Big radii read as soft and
friendly; 7px on a control reads as a machined part. The one outlier is `.a-brandmark` at 11px, a
squircle cartridge.

### The fixed heights

Every control lands on one of these, which is what makes a toolbar row line up with no fiddling.

| Element | Height |
|---|---|
| `.a-badge` | 20px |
| `.a-seg-item` | 26px (inside a 3px-padded track, so 34px total) |
| `.a-btn`, `.a-input`, `.a-select` | 32px |
| `.a-table th` | 30px |
| `.a-table td` | 38px |
| `.a-nav-item` | 38px |
| `.a-panel-head` | 44px min |
| Drawer header | 56px |

### Layout skeleton

```tsx
<div data-admin className="flex min-h-screen">
  {/* The rail is pinned to the viewport, not the page. h-screen + self-start stops flex from
      stretching it to the full document height, which is what silently breaks sticky. */}
  <nav className="a-rail sticky top-0 hidden h-screen w-[232px] shrink-0 flex-col
                  justify-between self-start overflow-y-auto p-3 lg:flex">
    …brand, nav items, footer
  </nav>

  <div className="flex min-w-0 flex-1 flex-col">
    {/* Under lg the rail becomes a horizontal scrolling strip */}
    <div className="sticky top-0 z-20 flex items-center gap-1 overflow-x-auto border-b px-2 py-2 lg:hidden">…</div>
    <main className="mx-auto min-w-0 w-full max-w-[1600px] flex-1 p-4 lg:p-6">{children}</main>
  </div>
</div>
```

- **Rail 232px.** Wide enough for `Performance` plus a 16px icon plus padding, narrow enough to not
  be furniture.
- **Content max 1600px, centered.** Past that, tables stop being scannable because the eye has to
  travel to correlate a name with its number.
- **`min-w-0` on every flex child that contains a table.** Without it a wide table refuses to shrink
  and blows out the page. This is the single most common layout bug on this kind of surface.

### The spacing rhythm

- **16px (`gap-4`) between panels.** Everywhere, vertical and horizontal.
- **8px (`gap-2`) between a section's micro-label and its tile row.**
- **16px inside a panel** (`.a-panel` padding, or `p-4` on a flush panel's content block).
- **14px horizontal in table cells**, matching the panel header's 14px so columns line up with the
  title above them.

### The grids

```tsx
grid gap-4 sm:grid-cols-2 xl:grid-cols-5      // stat tile row (5 metrics)
grid gap-4 sm:grid-cols-2 xl:grid-cols-3      // stat tile row (3 metrics)
grid gap-4 xl:grid-cols-2                     // two equal panels
grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,560px)]  // list + fixed-ish detail pane
grid gap-4 xl:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)] // primary + secondary panel
```

`minmax(0, …)` rather than `1fr` on any column holding a table, for the same shrink reason as above.

### Density has a floor

Under about 1024px these tables stop being readable. Say so rather than shipping a squeeze:

```tsx
<DesktopOnlyNotice page="Overview" />   // renders only under lg:
```

One page (the one you would actually triage from a phone) is exempt and stays usable narrow. Picking
that page deliberately is better than making all four mediocre at both sizes.

---

## 5. Surfaces

```css
/* The molded panel. Two variants share one material. */
.a-panel,
.a-panel-flush {
  background: linear-gradient(180deg, #111110 0%, #0d0d0d 56%, #090909 100%), #0d0d0d;
  border: 1px solid var(--a-border);
  border-radius: var(--a-radius);
  box-shadow:
    inset 0 1px 0 #242422,
    inset 0 -1px 4px rgb(0 0 0 / 0.46),
    0 1px 0 #050505;
}

.a-panel { padding: 16px; }              /* content sits inside the padding */
.a-panel-flush { overflow: hidden; }     /* content bleeds to the rounded edge (tables) */

/* Taller and quieter than a table head, so the two never blur into each other. */
.a-panel-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  min-height: 44px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--a-border);
}

/* An inset block cut into a panel: stacks, briefs, anything read as raw text. */
.a-well {
  background: var(--a-well);
  border: 1px solid var(--a-border);
  border-radius: var(--a-radius-sm);
  padding: 10px 12px;
}

/* A callout that must be read before something irreversible happens. Tinted, never solid. */
.a-callout-critical {
  border: 1px solid var(--a-critical);
  border-radius: var(--a-radius-sm);
  background: var(--a-critical-soft);
  padding: 12px;
}

/* The one frame that owns a shadow. */
.a-overlay {
  background: linear-gradient(180deg, #151513 0%, #0e0e0d 100%), #101010;
  border: 1px solid var(--a-border-strong);
  border-radius: var(--a-radius);
  box-shadow: 0 24px 60px rgb(0 0 0 / 0.7);
}
```

**Two panel variants, one decision.** `.a-panel` pads its content, use it when the content is text or
tiles. `.a-panel-flush` clips instead, use it when a table or a full-bleed element must run to the
rounded edge. A table inside a padded panel is the tell of a system that never made this call.

**The header carries state, not just a name.** Icon (14px, `strokeWidth` 2.4, in `--a-text-muted`) +
title + an optional grey note like `7 days` or `412 mints` + a right-aligned action. That note is
where the denominator lives, which is how a number never gets read without its scope.

```tsx
<Panel title="Workers" icon={Cpu} note="3 stale" action={<span className="a-badge a-badge-critical">attention</span>}>
```

The gradient stops (`#111110 → #0d0d0d → #090909`) are warm-shifted by one or two units, not neutral
grey. On a black OLED surface this is barely perceptible individually and reads as "warm equipment"
across a whole screen.

---

## 6. Tables

The workhorse. Get these five details right and tables stop needing any decoration at all.

```css
.a-table { width: 100%; border-collapse: collapse; font-size: 13px; }

.a-table th {
  height: 30px;
  padding: 0 14px;
  text-align: left;
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.12em;
  color: var(--a-text-3);
  background: rgb(255 255 255 / 0.02);   /* the faintest possible lift, not a filled bar */
  border-bottom: 1px solid var(--a-border);
  white-space: nowrap;
}

.a-table td {
  height: 38px;
  padding: 0 14px;
  border-bottom: 1px solid rgb(255 255 255 / 0.04);
  color: var(--a-text-2);
}

.a-table tbody tr:last-child td { border-bottom: none; }
```

### Numeric columns

```css
.a-num {
  white-space: nowrap;
  text-align: right;
  font-variant-numeric: tabular-nums;
  color: var(--a-text);
  font-weight: 600;
}

/* Cells only. On a flex item `width: 1%` becomes the automatic minimum size, so the number keeps its
   nowrap width and paints straight over whatever sits next to it. */
td.a-num,
th.a-num { width: 1%; }

.a-key { color: var(--a-text); font-weight: 600; }  /* the cell you scan for */

/* The column that absorbs the leftover width and truncates instead of widening the table. */
.a-cell-fill { width: 100%; max-width: 0; }
```

**`width: 1%` on a numeric column is the trick worth stealing.** In a collapsed table it means "as
narrow as the content allows", so a wide screen gives the extra space to the name column instead of
flinging every figure at the far rim where you cannot correlate it with its label. Keep it on
`td`/`th`, never on the bare class: elsewhere it is a real width and the text escapes its box.

**Pair it with `.a-cell-fill` on the one text column that can be long.** An auto-layout table sizes
columns to content, so a single unbroken fingerprint or module path widens the table until the numeric
columns fall off the panel. `max-width: 0` opts that cell out of the measurement, so it takes the
leftover width and truncates. Truncate it with `truncate`, not `line-clamp-1`: a title like
`module::function::code` has nothing to wrap on, and line-clamp collapses it to the first word.

**Numbers right, labels left, always.** Right-aligned tabular numerals align on the decimal for free,
which is the entire reason you can compare a column at a glance.

**Three text weights per row.** `.a-key` at full contrast for the thing you are looking for, plain
cells at `--a-text-2`, and `--a-text-muted` for anything present but not offered. A row where every
cell is the same weight is a row you have to read left to right.

### Selectable rows

```css
.a-row {
  cursor: pointer;
  box-shadow: inset 2px 0 0 transparent;   /* reserved up front, so selecting shifts nothing */
  transition: background-color 120ms ease-out, box-shadow 120ms ease-out;
}
.a-row:hover { background: var(--a-surface-hover); }
.a-row[aria-selected='true'] {
  background: var(--a-surface-hover);
  box-shadow: inset 2px 0 0 var(--a-accent);
}
```

Selection is an amber spine on the left edge, drawn as an inset shadow so it never affects layout.
A selected row must also be reachable: `tabIndex={0}` plus Enter/Space, since a clickable `<tr>` is
invisible to the keyboard otherwise.

---

## 7. Badges

```css
.a-badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 20px;
  padding: 0 7px;
  border-radius: 6px;
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  white-space: nowrap;
}

.a-badge-critical { color: var(--a-critical); background: var(--a-critical-soft); }
.a-badge-warn     { color: var(--a-warn);     background: var(--a-warn-soft); }
.a-badge-ok       { color: var(--a-ok);       background: var(--a-ok-soft); }
.a-badge-info     { color: var(--a-info);     background: var(--a-info-soft); }
.a-badge-accent   { color: var(--a-accent);   background: var(--a-accent-soft); }
.a-badge-neutral  { color: var(--a-text-3);   background: rgb(255 255 255 / 0.06); }
```

Six tones, no size variants, no outline variant, no dot variant. The formula is always **full-strength
text on its own hue at 12-13% alpha.**

Map domain vocabularies onto the six tones in one place, never inline at the call site:

```tsx
const STATUS_CLASS: Record<string, string> = {
  open: 'a-badge-critical', ack: 'a-badge-warn', resolved: 'a-badge-ok', ignored: 'a-badge-neutral',
}
```

A badge that has to render a machine string (an event name, an id) drops the uppercase treatment
inline: `style={{ textTransform: 'none', letterSpacing: 0 }}`. Uppercasing a `snake.case` identifier
makes it unreadable and, worse, wrong.

---

## 8. Numbers

```css
.a-metric {
  font-size: 30px; font-weight: 800; line-height: 1.05; letter-spacing: -0.02em;
  font-variant-numeric: tabular-nums; color: var(--a-text);
}
.a-metric-sm {
  font-size: 21px; font-weight: 700; line-height: 1.1; letter-spacing: -0.015em;
  font-variant-numeric: tabular-nums; color: var(--a-text);
}
```

The stat tile is a three-line shape, and the third line is the one people skip:

```tsx
<div className="a-panel flex min-w-0 flex-col gap-1.5">
  <span className="a-label">Net house PnL</span>   {/* mono micro-label, optional 12px icon */}
  <span className="a-metric" style={{ color: 'var(--a-critical)' }}>-$412.90</span>
  <span style={{ color: 'var(--a-text-3)', fontSize: 12 }}>counterparty is the vault, not us</span>
</div>
```

**Every hero number gets its denominator.** `1,204` means nothing; `1,204 · of 3,910 users, as of 4m
ago` is a fact. The hint line is where "as of", "of N", and the caveat live, and a tile without one is
usually a tile that is about to be misread.

**Tone is for the number, not the tile.** A metric colours its value via `tone`, never its background.
A red-backgrounded tile in a grid of eight makes the other seven look broken.

`truncate` + `min-w-0` on both the label and the value, or one long number breaks the grid.

---

## 9. Controls

### Buttons

```css
.a-btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 6px;
  height: 32px; padding: 0 12px;
  border-radius: var(--a-radius-xs);
  border: 1px solid var(--a-border-strong);
  background: linear-gradient(180deg, #1a1a18 0%, #131312 100%);
  color: var(--a-text-2);
  font-size: 12px; font-weight: 700;
  cursor: pointer; white-space: nowrap;
  transition: background-color 120ms ease-out, border-color 120ms ease-out, color 120ms ease-out;
}
.a-btn:hover:not(:disabled)  { background: var(--a-surface-hover); border-color: #3a3a35; color: var(--a-text); }
.a-btn:active:not(:disabled) { transform: translateY(0.5px); }
.a-btn:disabled              { opacity: 0.45; cursor: default; }

/* The commit key. Molded amber, warm near-black text, a hard lip in a brown shadow. */
.a-btn-primary {
  background: linear-gradient(180deg, #ffd24a 0%, #f2a60e 100%);
  border-color: #d9990f;
  color: #1a1200;
  box-shadow:
    inset 0 1px 0 rgb(255 255 255 / 0.45),
    0 1px 0 rgb(71 45 0 / 0.65);
}
.a-btn-primary:hover:not(:disabled) {
  background: linear-gradient(180deg, #ffdc6b 0%, #f9b31c 100%);
  border-color: #d9990f; color: #1a1200;
}
```

The 0.5px press on the secondary button is the smallest travel that still registers as a press. The
primary's drop shadow is **brown** (`rgb(71 45 0 / 0.65)`), not black: a coloured object casts a
shadow tinted by its own hue, and a black drop under amber immediately reads as a sticker.

**One primary per view.** In this dashboard it is `Copy AI brief`, the single action the page exists
for. Everything else, including the destructive actions, is a plain `.a-btn`.

### Segmented control

The window picker: one recessed track with the active cell lifted out of it. Both planes in one
control, which is why it is the most convincing part of the 2D system.

```css
.a-seg {
  display: inline-flex; padding: 3px; gap: 2px;
  border-radius: var(--a-radius-sm);
  border: 1px solid var(--a-border);
  background: #0a0a09;
  box-shadow: inset 0 2px 5px rgb(0 0 0 / 0.6);   /* sunken */
}
.a-seg-item {
  display: inline-flex; align-items: center; justify-content: center;
  height: 26px; min-width: 46px; padding: 0 10px;
  border: none; border-radius: 7px; background: transparent;
  color: var(--a-text-3); font-size: 12px; font-weight: 700; cursor: pointer;
  transition: background-color 120ms ease-out, color 120ms ease-out;
}
.a-seg-item:hover:not([data-active='true']) { color: var(--a-text-2); }
.a-seg-item[data-active='true'] {
  background: linear-gradient(180deg, #2c2b27 0%, #201f1c 100%);
  color: var(--a-accent);
  box-shadow:
    inset 0 1px 0 rgb(255 255 255 / 0.08),
    0 1px 2px rgb(0 0 0 / 0.5);                    /* raised, inside the groove */
}
```

Use it for 3-5 mutually exclusive options that should all stay visible (`1h · 6h · 24h · 7d`). Past
five, or when the options are not worth showing at rest, use the select. Mark it up as
`role="radiogroup"` with `role="radio"` + `aria-checked` children, and drive the visual off a
`data-active` attribute so the styling never diverges from the accessible state.

### Inputs and selects

```css
.a-select, .a-input {
  height: 32px; padding: 0 10px;
  border-radius: var(--a-radius-xs);
  border: 1px solid var(--a-border-strong);
  background-color: #0a0a09;
  color: var(--a-text); font-family: inherit; font-size: 12px; font-weight: 600;
  box-shadow: inset 0 1px 3px rgb(0 0 0 / 0.5);   /* sunken, the cheap one-layer version */
}
.a-select:hover, .a-input:hover { border-color: #3a3a35; }

/* The native chevron is a light-mode widget and reads as a stray browser part here. */
.a-select {
  appearance: none;
  padding-right: 26px;
  background-image: url("data:image/svg+xml;charset=utf-8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'%3E%3Cpath d='M1 1l4 4 4-4' fill='none' stroke='%238a8a8a' stroke-width='1.6' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
  background-repeat: no-repeat;
  background-position: right 9px center;
}
.a-select option { background: #0f0f0e; color: var(--a-text); }
```

Numeric inputs are right-aligned and narrow (`className="a-input w-[104px] text-right"`), matching the
`.a-num` convention so a form of numbers reads like a column of numbers.

### Focus

```css
[data-admin] :focus-visible {
  outline: 2px solid rgb(255 192 22 / 0.55);
  outline-offset: 2px;
}
```

One amber ring on everything, `:focus-visible` so it is keyboard-only. **Never `outline: none`.** This
is a surface people drive from the keyboard at 3am.

---

## 10. Navigation

```css
/* The rail sits a shade UNDER the canvas so the content area reads as the lit surface. */
.a-rail {
  background: linear-gradient(180deg, #0b0b0a 0%, #060606 100%);
  border-right: 1px solid var(--a-border);
}

/* The wordmark cartridge: the same molded amber as the commit key, as a squircle tile. */
.a-brandmark {
  display: flex; align-items: center; justify-content: center; flex: none;
  width: 36px; height: 36px; border-radius: 11px;
  background: linear-gradient(180deg, #ffd550 0%, #ffc016 46%, #ef9f0a 100%);
  color: #1a1200; font-size: 15px; font-weight: 900;
  box-shadow:
    inset 0 1.5px 0 rgb(255 255 255 / 0.55),   /* top gloss */
    0 2px 0 rgb(86 55 0 / 0.7),                /* hard coloured lip */
    0 8px 18px -10px rgb(0 0 0 / 0.9);         /* soft ambient drop */
}

.a-nav-item {
  position: relative;
  display: flex; align-items: center; gap: 10px;
  height: 38px; padding: 0 12px;
  border-radius: var(--a-radius-xs);
  color: var(--a-text-3);
  font-size: 13.5px; font-weight: 600;
  text-decoration: none; white-space: nowrap;
  transition: background-color 120ms ease-out, color 120ms ease-out;
}
.a-nav-item:hover { background: rgb(255 255 255 / 0.04); color: var(--a-text); }
.a-nav-item[data-active='true'] {
  background: linear-gradient(180deg, #1c1b17 0%, #151411 100%);  /* warm, amber-tinted */
  color: var(--a-text);
  box-shadow: inset 0 1px 0 rgb(255 255 255 / 0.05);
}

/* The active marker: an amber bar bleeding off the rail's left edge. Scoped to the rail on purpose: the
   same items laid out horizontally on mobile would put the bar on top of the previous tab. */
.a-rail .a-nav-item[data-active='true']::before {
  content: '';
  position: absolute;
  left: -12px; top: 9px; bottom: 9px;
  width: 3px;
  border-radius: 0 3px 3px 0;
  background: var(--a-accent);
  box-shadow: 0 0 10px rgb(255 192 22 / 0.55);   /* the glow is what makes it read as lit, not painted */
}

.a-nav-item[data-active='true'] .a-nav-icon { color: var(--a-accent); }
.a-nav-icon { flex: none; color: var(--a-text-muted); transition: color 120ms ease-out; }
.a-nav-item:hover .a-nav-icon { color: var(--a-text-2); }
```

Three signals stack on the active item: a warm raised background, full-contrast text, and the glowing
amber spine. Any one alone is ambiguous at a glance on a dark rail.

The rail being **darker** than the content is the whole trick of the frame. Most dark dashboards do
the opposite and end up with a sidebar that competes with the data.

### The status dot

```css
.a-dot {
  width: 8px; height: 8px; border-radius: 50%; flex: none;
  box-shadow: 0 0 8px currentColor;   /* set color AND background to the same token, get an LED */
}
```

```tsx
<span className="a-dot" style={{ background: color, color }} title={label} aria-label={label} />
```

Four states, not two: pending (`--a-text-muted`), ok, warn, critical. **An unreadable health check is
not a healthy one.** If the sweep cannot be read it goes amber, never green. A green dot above a red
banner is the kind of small contradiction that teaches people not to trust either.

---

## 11. The 3D hardware kit

The tactile layer, lifted from the product's physical device and generalized. In the dashboard only
the toggle is used, on the settings drawer, and that restraint is the point: **the hardware kit is for
the handful of controls that commit something.** A dashboard made of chunky metal keys is a toy.

Everything below is `:hover` / `:active` / `:focus-visible` CSS. No JS drives any state.

### The press physics

Every key in the kit obeys the same three-state contract, and it is worth stating on its own because
it is the reusable part:

| State | Transform | Shadow |
|---|---|---|
| rest | `none` | Raised: top highlight inset, bottom dark inset, hard 2px lip, soft ambient drop, dim amber rim |
| hover | `translateY(-1px)` | Same, plus lip to 3px, ambient deeper, **amber rim to full + a glow** |
| active | `translateY(1.5px)` | Flips fully inset: the drop and lip vanish, `inset 0 3px 6px` appears |

The key detail is that **press inverts the plane.** It does not dim, it does not shrink. It stops
being raised and becomes sunken, which is what a real key does. Total travel is 2.5px between hover
and press, and that small distance over 120ms is what reads as a firm, well-damped switch.

The second detail: **the amber LED rim is always physically there.** At rest it is
`0 0 0 1px rgba(245,166,35,0.16)`, a barely-visible ring. Hover takes it to `0.6` and adds an 11px
glow. The light does not appear from nowhere, it turns up, which is why it reads as a lit part rather
than a hover effect.

### The keys

```css
/* Machined bezel plate: the surface everything else mounts onto. */
.hw3d-panel {
  background: linear-gradient(180deg, #3b3e44 0%, #26282c 52%, #191b1e 100%);
  border: 1px solid rgba(0, 0, 0, 0.45);
  border-radius: 18px;
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.14),
    inset 0 -1px 0 rgba(0, 0, 0, 0.55),
    0 12px 26px -10px rgba(0, 0, 0, 0.6);
}

/* The base metallic key. */
.hw3d-key {
  position: relative;
  display: inline-flex; align-items: center; justify-content: center; gap: 0.5rem;
  border: none; cursor: pointer;
  border-radius: 13px; padding: 0 1.25rem; height: 3rem;
  color: #eef1f4; font-weight: 800; letter-spacing: 0.02em;
  background:
    radial-gradient(130% 84% at 50% -16%, rgba(255, 255, 255, 0.17) 0%, transparent 58%),
    linear-gradient(180deg, #565b63 0%, #3a3d43 48%, #24262a 100%);
  box-shadow:
    inset 0 1.5px 0.5px rgba(255, 255, 255, 0.46),
    inset 0 -3px 6px rgba(0, 0, 0, 0.55),
    0 2px 0 rgba(0, 0, 0, 0.55),
    0 6px 12px -3px rgba(0, 0, 0, 0.6),
    0 0 0 1px rgba(245, 166, 35, 0.16);
  transition:
    transform 120ms var(--ease-out-quart),
    box-shadow 170ms ease,
    background 170ms ease,
    filter 160ms ease;
}
.hw3d-key:not(:disabled):hover {
  transform: translateY(-1px);
  box-shadow:
    inset 0 1.5px 0.5px rgba(255, 255, 255, 0.46),
    inset 0 -3px 6px rgba(0, 0, 0, 0.55),
    0 3px 0 rgba(0, 0, 0, 0.55),
    0 9px 16px -3px rgba(0, 0, 0, 0.62),
    0 0 0 1px rgba(245, 166, 35, 0.6),
    0 0 11px -1px rgba(245, 166, 35, 0.38);
}
.hw3d-key:not(:disabled):active {
  transform: translateY(1.5px);
  background:
    radial-gradient(130% 84% at 50% -16%, rgba(255, 255, 255, 0.09) 0%, transparent 58%),
    linear-gradient(180deg, #43464c 0%, #2c2e33 55%, #1c1e21 100%);
  box-shadow:
    inset 0 3px 6px rgba(0, 0, 0, 0.62),
    inset 0 1px 1px rgba(255, 255, 255, 0.1),
    0 1px 2px rgba(0, 0, 0, 0.4);
}
.hw3d-key:focus-visible { outline: 2px solid rgba(245, 166, 35, 0.6); outline-offset: 2px; }
.hw3d-key:disabled {
  cursor: not-allowed;
  filter: saturate(0.7) brightness(0.8);
  opacity: 0.55;
  transform: none;
  box-shadow:
    inset 0 1px 1px rgba(255, 255, 255, 0.12),
    inset 0 -2px 5px rgba(0, 0, 0, 0.5),
    0 2px 0 rgba(0, 0, 0, 0.5);
}

/* Compact key: same material, shrunk for tight rows. */
.hw3d-key-sm { height: 2.25rem; padding: 0 0.875rem; border-radius: 10px; gap: 0.375rem; }
```

The `radial-gradient(130% 84% at 50% -16%, …)` layered over the body gradient is the **specular
hotspot**: a soft light pool originating above the top edge of the key. Painting it as a separate
layer means the press state can dim it (0.17 → 0.09) independently of the body colour, which is
exactly what happens when a real cap tilts away from the light.

Note that the key rides on **five** shadow layers where the flat panel uses three. That is the entire
budget difference between "molded panel" and "physical key", and it is why you use one sparingly.

```css
/* Amber commit key. Always faintly lit, brightens under the finger. */
.hw3d-key-primary {
  color: #1a1200;
  background:
    radial-gradient(130% 84% at 50% -16%, rgba(255, 255, 255, 0.42) 0%, transparent 56%),
    linear-gradient(180deg, #ffd76a 0%, #f7b21e 48%, #d98a12 100%);
  box-shadow:
    inset 0 1.5px 0.5px rgba(255, 255, 255, 0.62),
    inset 0 -3px 6px rgba(153, 95, 0, 0.5),
    0 2px 0 rgba(120, 74, 0, 0.6),
    0 6px 14px -3px rgba(0, 0, 0, 0.6),
    0 0 11px -3px rgba(245, 166, 35, 0.36);
}
.hw3d-key-primary:not(:disabled):hover {
  transform: translateY(-1px);
  filter: brightness(1.05);
  box-shadow:
    inset 0 1.5px 0.5px rgba(255, 255, 255, 0.62),
    inset 0 -3px 6px rgba(153, 95, 0, 0.5),
    0 3px 0 rgba(120, 74, 0, 0.6),
    0 10px 20px -4px rgba(0, 0, 0, 0.6),
    0 0 20px -2px rgba(245, 166, 35, 0.6);
}
.hw3d-key-primary:not(:disabled):active {
  transform: translateY(1.5px);
  filter: none;
  background: linear-gradient(180deg, #e6a415 0%, #cf8f0f 60%, #b87c0c 100%);
  box-shadow:
    inset 0 2px 5px rgba(84, 51, 0, 0.7),
    0 1px 2px rgba(0, 0, 0, 0.4),
    0 0 14px -2px rgba(245, 166, 35, 0.5);
}

/* Destructive key. Same recipe, coral-red plastic. */
.hw3d-key-danger {
  color: #2a0603;
  background:
    radial-gradient(130% 84% at 50% -16%, rgba(255, 255, 255, 0.34) 0%, transparent 56%),
    linear-gradient(180deg, #ff9a8d 0%, #ff6b5a 46%, #e2392c 100%);
  box-shadow:
    inset 0 1.5px 0.5px rgba(255, 255, 255, 0.48),
    inset 0 -3px 6px rgba(103, 14, 9, 0.42),
    0 2px 0 rgba(76, 9, 6, 0.65),
    0 6px 14px -3px rgba(0, 0, 0, 0.6),
    0 0 11px -3px rgba(255, 108, 90, 0.4);
}
.hw3d-key-danger:not(:disabled):hover {
  transform: translateY(-1px);
  filter: brightness(1.05);
  box-shadow:
    inset 0 1.5px 0.5px rgba(255, 255, 255, 0.48),
    inset 0 -3px 6px rgba(103, 14, 9, 0.42),
    0 3px 0 rgba(76, 9, 6, 0.65),
    0 10px 20px -4px rgba(0, 0, 0, 0.62),
    0 0 20px -2px rgba(255, 108, 90, 0.6);
}
.hw3d-key-danger:not(:disabled):active {
  transform: translateY(1.5px);
  filter: none;
  background: linear-gradient(180deg, #dd4b3c 0%, #c23528 60%, #a02a1e 100%);
  box-shadow:
    inset 0 2px 5px rgba(45, 6, 3, 0.7),
    0 1px 2px rgba(0, 0, 0, 0.4),
    0 0 14px -2px rgba(255, 108, 90, 0.5);
}
```

**The coloured-key recipe, so you can make a fourth.** Take the neutral key and substitute: body
gradient in three steps of the hue (light / mid / deep), the bottom inset in a **dark version of the
hue** rather than black, the hard lip in a darker still version of the hue, and the glow in the hue at
0.36-0.4. Keep the white top inset white, raise it a little (0.46 → 0.62 on amber) because a lighter
plastic catches more specular. Text is a near-black tinted toward the hue (`#1a1200` on amber,
`#2a0603` on red), never `#000`.

### The socketed round key

```css
/* The dark socket the cap sits in. */
.hw3d-socket {
  display: inline-flex;
  padding: 3px;
  border-radius: 50%;
  background: radial-gradient(120% 120% at 50% 30%, #16171a 0%, #0c0d0f 100%);
  box-shadow:
    inset 0 2px 4px rgba(0, 0, 0, 0.8),
    inset 0 -1px 0 rgba(255, 255, 255, 0.05);
}
.hw3d-cap {
  display: grid; place-items: center;
  border: none; cursor: pointer; border-radius: 50%;
  background: radial-gradient(120% 120% at 50% 26%, #565b63 0%, #34373d 46%, #1c1e21 100%);
  box-shadow:
    inset 0 1px 1px rgba(255, 255, 255, 0.28),
    inset 0 -3px 6px rgba(0, 0, 0, 0.55),
    0 4px 9px -2px rgba(0, 0, 0, 0.6);
  transition:
    transform 120ms var(--ease-out-quart),
    box-shadow 160ms ease,
    background 160ms ease;
}
.hw3d-cap:hover {
  transform: translateY(-0.5px);
  box-shadow:
    inset 0 1px 1px rgba(255, 255, 255, 0.28),
    inset 0 -3px 6px rgba(0, 0, 0, 0.55),
    0 4px 9px -2px rgba(0, 0, 0, 0.6),
    0 0 0 1px rgba(245, 166, 35, 0.33),
    0 0 14px rgba(245, 166, 35, 0.27);
}
.hw3d-cap:active {
  transform: translateY(1.5px);
  background: radial-gradient(120% 120% at 50% 70%, #34373d 0%, #202226 60%, #17181b 100%);
  box-shadow:
    inset 0 2px 5px rgba(0, 0, 0, 0.7),
    0 1px 2px rgba(0, 0, 0, 0.4);
}
.hw3d-cap:focus-visible { outline: 2px solid rgba(245, 166, 35, 0.6); outline-offset: 3px; }

/* Dead key: flat in its socket, no dome, no press. */
.hw3d-cap:disabled,
.hw3d-cap:disabled:hover,
.hw3d-cap:disabled:active {
  cursor: default;
  transform: none;
  background: radial-gradient(120% 120% at 50% 30%, #202226 0%, #16171a 100%);
  box-shadow: inset 0 1px 3px rgba(0, 0, 0, 0.6);
}
```

**The press moves the light source, not just the shadow.** Rest is
`radial-gradient(… at 50% 26%)`, a highlight near the top of the dome. Active is `at 50% 70%`, the
highlight sliding to the bottom. That is the cap physically tipping under a finger, and it is far more
convincing than dimming.

The disabled cap is the other lesson: a dead key is not a faded key, it is a **flat** key. It loses
the dome entirely and keeps only the socket's inner shadow. Nothing about it invites a press.

Icons inside a cap get a double drop-shadow filter so they sit on the surface rather than in it:

```tsx
filter: `drop-shadow(0 1px 1px rgba(0,0,0,0.6)) drop-shadow(0 0 5px ${accent}55)`
```

### The slide toggle

The one hardware part the dashboard actually uses, for every boolean setting.

```css
.hw3d-toggle {
  position: relative; display: inline-block;
  width: 3.5rem; height: 1.875rem;
  border-radius: 9999px;
  border: 1px solid #0c0d0f;
  cursor: pointer;
  background: linear-gradient(180deg, #121316 0%, #1d1f22 100%);   /* inverted = groove */
  box-shadow:
    inset 0 2px 5px rgba(0, 0, 0, 0.75),
    inset 0 -1px 0 rgba(255, 255, 255, 0.05);
  transition: transform 120ms var(--ease-out-quart);
}
.hw3d-toggle:not(:disabled):active { transform: scale(0.98); }
.hw3d-toggle:focus-visible { outline: 2px solid rgba(245, 166, 35, 0.6); outline-offset: 2px; }
.hw3d-toggle:disabled { cursor: not-allowed; opacity: 0.5; }

/* Amber level fill, revealed when on. It is always rendered, only its opacity animates. */
.hw3d-toggle-fill {
  position: absolute; inset: 2px; border-radius: 9999px;
  background: linear-gradient(180deg, #ffd25e 0%, #f5a623 55%, #d98a12 100%);
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.45),
    0 0 10px rgba(245, 166, 35, 0.5);
  opacity: 0;
  transition: opacity 180ms var(--ease-out-quart);
  pointer-events: none;
}
.hw3d-toggle[aria-checked='true'] .hw3d-toggle-fill { opacity: 1; }

/* The proud ridged cap. Taller than the groove, which is what "proud" means. */
.hw3d-toggle-thumb {
  position: absolute; top: 50%; left: 0;
  width: 1.75rem;
  height: calc(100% + 6px);           /* overhangs the track by 3px top and bottom */
  border-radius: 7px;
  background: linear-gradient(180deg, #5a5f66 0%, #3d4046 48%, #2a2c30 100%);
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.4),
    inset 0 -2px 3px rgba(0, 0, 0, 0.5),
    0 4px 8px -1px rgba(0, 0, 0, 0.65);
  transform: translate(-3px, -50%);
  transition: transform 190ms var(--ease-out-quart);
}
.hw3d-toggle[aria-checked='true'] .hw3d-toggle-thumb {
  transform: translate(calc(3.5rem - 1.75rem - 1px), -50%);
}

/* Grip ridges: 1px light lines every 3px. */
.hw3d-toggle-thumb::before {
  content: '';
  position: absolute; inset: 4px 3px; border-radius: 3px;
  background-image: repeating-linear-gradient(
    0deg, rgba(255, 255, 255, 0.16) 0 1px, transparent 1px, transparent 3px);
}

/* Center index line: dim metal off, lit amber on. */
.hw3d-toggle-thumb::after {
  content: '';
  position: absolute; left: 50%; top: 50%;
  width: 2px; height: 62%; border-radius: 1px;
  transform: translate(-50%, -50%);
  background: #8d939b;
  transition: background 180ms var(--ease-out-quart), box-shadow 180ms var(--ease-out-quart);
}
.hw3d-toggle[aria-checked='true'] .hw3d-toggle-thumb::after {
  background: #f5a623;
  box-shadow: 0 0 6px #f5a623;
}
```

Four things make this read as hardware rather than as an iOS switch:

1. **The cap is taller than the track** (`calc(100% + 6px)`) and overhangs it. A thumb that fits
   inside its track is a UI widget; one that stands proud of it is a part.
2. **It is a rounded rectangle in a pill**, not a circle. Circles read as software.
3. **Grip ridges**, a 1-in-3px repeating gradient. Nearly invisible, completely load-bearing.
4. **A centre index line that lights up.** The state is carried three ways at once: fill, position,
   and the LED. A colour-blind user still gets position and the ridge line.

The fill animates on **opacity only** and the thumb on **transform only**. Both are compositor
properties, so the whole toggle is one GPU layer with no layout work.

Markup is a real button, and the CSS keys off the ARIA attribute, so the two can never disagree:

```tsx
<button type="button" role="switch" aria-checked={isSelected} aria-label={label} className="hw3d-toggle">
  <span className="hw3d-toggle-fill" />
  <span className="hw3d-toggle-thumb" />
</button>
```

### The fader

The Game Boy volume slider: a notched groove, an amber level fill, and a ridged cap. Inline-styled in
`Hardware3D.tsx` since the travel is computed. The material, for reference:

```ts
// track (sunken)
background: 'linear-gradient(180deg, #121316 0%, #1d1f22 100%)'
boxShadow: 'inset 0 2px 5px rgba(0,0,0,0.75), inset 0 -1px 0 rgba(255,255,255,0.05)'

// amber level fill. Square on the right so it reads as a level, not as a pill.
borderRadius: '11px 4px 4px 11px'
background: 'linear-gradient(180deg, #ffd25e 0%, #f5a623 55%, #d98a12 100%)'
boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.45), 0 0 10px #f5a62355'

// etched scale ticks over the groove: a 1px line every 10%, blended into the surface
backgroundImage: 'repeating-linear-gradient(90deg, rgba(0,0,0,0.35) 0 1px, transparent 1px, transparent 10%)'
opacity: 0.55
mixBlendMode: 'overlay'      // this is why the ticks look etched rather than drawn on

// the cap, 22 x 30 (taller than the 22px track, proud again)
background: 'linear-gradient(180deg, #5a5f66 0%, #3d4046 48%, #2a2c30 100%)'
boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.4), inset 0 -2px 3px rgba(0,0,0,0.5), 0 4px 8px -1px rgba(0,0,0,0.65)'
// while dragging, add: 0 0 0 1px #f5a62355   and   transform: scale(1.04)
```

Two behaviours worth copying with it:

- **The grab owns the pointer.** On pointer-down it attaches `pointermove` / `pointerup` /
  `pointercancel` to `window`, not to the element. The finger can wander off the track, above it, or
  clean off the sheet, and the cap still follows. `setPointerCapture` is attempted and its failure
  ignored, because the window listeners carry the drag either way.
- **The cap centre travels half a cap in from each rim,** so the usable track is `width - thumb`:
  `calc(11px + (100% - 22px) * value)`. Fill and cap use the same expression and therefore always
  agree. Getting this wrong is why most hand-rolled sliders have a cap that hangs off the end at 100%.

---

## 12. Data visualization, no library

Four SVG components, about 90 lines total, zero dependencies. On a dashboard of this shape, a chart
library is a megabyte to draw four shapes you can write yourself and actually restyle.

**The rule they all follow: colour carries meaning only.** Amber is the reading, `--a-text-3` is
scale, `--a-critical` is a real problem. A bar that represents a count is neutral, always.

### The proportion bar

```tsx
export function Bar({ fraction, tone = 'neutral', height = 6 }) {
  const pct = Math.max(0, Math.min(100, fraction * 100))
  const fill = tone === 'accent' ? 'var(--a-accent)'
             : tone === 'muted'  ? 'var(--a-text-muted)'
             : 'var(--a-text-3)'
  return (
    <span className="block w-full overflow-hidden"
          style={{ height, borderRadius: height / 2, background: 'var(--a-track)' }}
          role="img" aria-label={`${Math.round(pct)}%`}>
      <span className="block h-full" style={{
        width: `${pct}%`, borderRadius: height / 2, background: fill,
        boxShadow: tone === 'accent' ? 'var(--a-accent-glow)' : undefined,
      }} />
    </span>
  )
}
```

`borderRadius: height / 2` makes it a capsule at any height. The amber glow only fires on the accent
tone, so the bar that matters is also the one that is lit.

Inside a table, the bar column takes an explicit `width` (34-45%) and the numeric columns stay at
`width: 1%`. That is a table that reads as a chart with a legend built in.

### Sparkline

```tsx
const max = Math.max(1, ...data.map((d) => d.n))
const step = 100 / (data.length - 1)
const y = (n: number) => height - 1 - (n / max) * (height - 3)
const points = data.map((d, i) => `${(i * step).toFixed(2)},${y(d.n).toFixed(2)}`).join(' ')

<svg viewBox={`0 0 100 ${height}`} preserveAspectRatio="none" style={{ width: '100%', height }}
     role="img" aria-label={`${total} over ${data.length} days, peak ${max}`}>
  <polygon points={`0,${height} ${points} 100,${height}`} fill={tone} opacity={0.1} />
  <polyline points={points} fill="none" stroke={tone} strokeWidth={1.5}
            vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
</svg>
```

Three details make this work at any width:

1. **`viewBox="0 0 100 H"` + `preserveAspectRatio="none"`.** The x axis is a percentage, so the chart
   is fluid with no measurement, no ResizeObserver, and no layout pass.
2. **`vectorEffect="non-scaling-stroke"`.** Without it the non-uniform scale squashes the stroke into
   a hairline horizontally and a slab vertically. This one attribute is the entire reason the trick
   above is usable.
3. **A 10%-opacity fill under the line.** A flat series with no fill reads as a stray horizontal rule.
   The fill is what says "this is a series that happens to be flat".

Under two points it renders `not enough history` rather than an empty box. An empty chart looks
broken; a chart that says why does not.

### Bar chart

```tsx
const max = Math.max(1, ...data.map((d) => d.n))
const w = 100 / Math.max(1, data.length)
const h = d.n === 0 ? 0 : Math.max(1.5, (d.n / max) * (height - 2))
<rect x={i * w + w * 0.15} y={height - h} width={w * 0.7} height={h} fill="var(--a-text-3)" />
```

`w * 0.15` inset with `w * 0.7` width gives a 30% gutter at any bucket count. The
`Math.max(1.5, …)` floor means a bucket with one event still draws a visible stub, while a genuine
zero draws nothing at all. The difference between "almost none" and "none" is exactly what you are
reading a bar chart for.

### Two-line latency chart

p50 in grey under p95 in amber. p95 gets the accent because it is the number that describes what the
slowest users actually felt.

```tsx
// A null bucket BREAKS the line rather than drawing straight through a gap that had no traffic.
const path = (pick) =>
  data.map((d, i) => { const v = pick(d); return v == null ? null : `${(i*step).toFixed(2)},${y(v).toFixed(2)}` })
      .reduce((acc, point, i) => {
        if (point == null) return acc
        const prev = pick(data[i - 1] ?? { p50: null, p95: null })
        acc.push(`${prev == null ? 'M' : 'L'}${point}`)   // resume with M after a gap, not L
        return acc
      }, [])
      .join(' ')
```

**Interpolating through a gap is lying with a chart.** A window with no traffic is not a smooth ramp
between the buckets on either side of it. Emitting `M` after any null is four lines of code and it is
the difference between a chart you can trust and one you cannot.

No legend, no axes, no gridlines, no tooltips. Two lines with the p50/p95 values printed above them as
`.a-metric-sm` stats says everything a legend would, in less space.

### Accessibility

Every chart is `role="img"` with an `aria-label` that states the actual reading:
`"p50 and p95 over time, peak 412ms"`. A screen reader gets the conclusion, not a shape.

---

## 13. The four states

Every panel renders four states and all four get real copy. This is a bigger part of the quality of
the surface than any gradient in this document.

```tsx
{q.isPending && <LoadingState label="Reading play timings and worker health" rows={6} />}
{q.isError   && <ErrorState message={(q.error as Error).message} onRetry={() => void q.refetch()} />}
{q.data && !q.data.rows.length && <EmptyState icon={Cpu} title="…" hint="…" />}
{q.data && <Body data={q.data} />}
```

**Loading is skeleton rows, not the word "Loading".** The layout is already known, so show it
settling. Widths step down so it reads as content rather than as a progress bar:

```tsx
{Array.from({ length: rows }, (_, i) => (
  <div key={i} className="a-shimmer" style={{ height: 14, width: `${100 - i * 9}%` }} />
))}
```

```css
.a-shimmer {
  background: linear-gradient(100deg,
    rgb(255 255 255 / 0.03) 30%,
    rgb(255 255 255 / 0.07) 50%,
    rgb(255 255 255 / 0.03) 70%);
  background-size: 200% 100%;
  border-radius: var(--a-radius-xs);
  animation: a-shimmer 1.4s linear infinite;
}
@keyframes a-shimmer { to { background-position: -200% 0; } }
```

**Empty states have to distinguish healthy from broken.** This is the rule that matters most, and it
is a writing rule, not a design one. `No data` tells a reader nothing about which of those two they
are looking at, and that is the exact difference you need at 3am.

| Bad | Good |
|---|---|
| No workers | *No workers registered on this instance. Nothing is settling plays, syncing markets, or pruning analytics. Check the API logs for a boot failure.* |
| Nothing open | *Every captured bug is acknowledged, resolved, or ignored. 4 groups resolved in the last 7 days.* (proves the pipeline is alive) |
| No events | *Either nobody has used the app in this window, or analytics is switched off in Settings. Worth knowing which.* |

An empty table that means "everything is dead" must never look like an empty table that means
"all clear". Where the difference matters, the empty state says which one it is, in a sentence.

**Health-unknown is its own state, not an absence.** If the health check itself fails, render an amber
banner saying so. A missing banner reads as healthy, which is the worst possible thing to say when the
health read is the thing that broke.

---

## 14. Motion

| Duration | Easing | For |
|---|---|---|
| 120ms | `ease-out` | Everything 2D: hover, selection, colour and background changes |
| 120ms | `--ease-out-quart` | Hardware key press travel |
| 160-170ms | `ease` | Hardware shadow and background crossfades |
| 180-190ms | `--ease-out-quart` | Toggle thumb travel, fill fade |
| 1.4s | `linear` infinite | Skeleton shimmer |

`--ease-out-quart` is `cubic-bezier(0.25, 1, 0.5, 1)`.

**Nothing here animates layout.** Every transition is on `background-color`, `border-color`, `color`,
`opacity`, `box-shadow`, or `transform`. No height, no width, no top/left.

**120ms is a dashboard's speed.** This is a surface someone drives for an hour at a time. Anything
slower than about 150ms on a hover starts to feel like lag rather than polish.

**Reserve the space for state changes up front.** The `.a-row` selection spine ships as
`inset 2px 0 0 transparent` at rest, so selecting a row shifts nothing. Same idea as the always-present
amber LED rim on the keys.

```css
@media (prefers-reduced-motion: reduce) {
  [data-admin] *,
  [data-admin] *::before,
  [data-admin] *::after {
    transition: none !important;
    animation: none !important;
  }
}
```

One blanket rule at the bottom of the stylesheet. Nothing here is meaningful motion, so nothing needs
a reduced-motion variant.

---

## 15. The rules that keep it good

These are the ones enforced by a check script (`bun run check:admin`) rather than by review, because a
rule that does not fail a gate somebody runs is a suggestion.

1. **No raw colour in a component file.** No hex, no `rgb()`, no `hsl()` outside the stylesheet. SVG
   charts are the only exemption and they still have to name a `var()`. This is how a two-token
   severity scheme stays two tokens.
2. **No heavy imports.** The dashboard bans WebGL, timeline animation libraries, the product's device
   shell and its audio engine by module specifier. All of them either mount a renderer or drag a
   megabyte of scene code onto a page made of tables. Encapsulation that is not enforced is decorative.
3. **Never render HTML.** `dangerouslySetInnerHTML` is banned outright, not reviewed. Error messages
   and analytics props carry attacker-controlled input and this is the surface where they get
   displayed.
4. **Keep the twins in sync.** Where a client-side list mirrors a server-side source of truth (role
   names, an event catalog), the script diffs them and fails on drift.

Three more that are conventions rather than gates, but hold the look together:

5. **One folder.** Pages, primitives, queries, types and the stylesheet live in one directory. The
   whole surface is portable by copying it, which is the reason this document can exist.
6. **One primary action per view.** If two things on screen are amber-filled, neither is the one to
   press.
7. **Every number carries its scope.** A count with no window, denominator, or "as of" is a number
   somebody is about to misread in a meeting.
