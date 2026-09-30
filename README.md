# GIA / GIL Splitter

A static web tool for the two Miliastra Wonderland asset formats. It is one
editor that changes its layout depending on which file type you load:

- **`.gia` asset packs**: look at each model's Decoration list, pick some
  entries, and move them into a new model. You can do this as many times as
  you want, then download the result. Entries keep their original order on
  both sides of every split.
- **`.gia` entity groups**: a prefab or entity group export lists its member
  entities. Move any or all of them out of the group and they become separate
  main objects at the same world placement. The group is removed once it is
  empty.
- **`.gil` levels**: check parent objects, pick some of their attached
  decorations, and extract them into standalone world objects with the same
  world position, rotation, scale and collision state.

In both modes, data you don't touch is kept byte for byte. That includes
fields and entry types the tool doesn't know about.

Everything runs in the browser. There is no server and nothing is uploaded.
You can load a file with the picker, by dropping it anywhere on the page, or
by pasting it with Ctrl+V after copying it from the OS.

The interface is translated into 15 languages: the 14 that Genshin Impact
supports officially, plus Italian. That is English, 简体中文, 繁體中文, 日本語,
한국어, Français, Deutsch, Español, Português, Русский, ไทย, Tiếng Việt,
Bahasa Indonesia, Türkçe and Italiano. The language selector in the top bar
switches without a reload, and the choice is shared with the other Miliastra
Toolkit sites through the `miliastra-lang` key.

## Usage: .gia

1. Open the site and drop a `.gia` file anywhere on the page, or click
   *Choose a .gia / .gil file*.
2. Pick a model in the list on the left. Each row shows its Decoration entry
   count. Every model also has an export checkbox in the sidebar. Checked
   models go into the download, unchecked ones are dimmed. This has nothing to
   do with which model is currently open for viewing.
3. Select entries in the Decoration table. A click toggles a row without
   clearing the rest of the selection. Shift+click inverts the whole range
   from the last row you clicked, so toggling a row on and shift-clicking
   selects the range, and toggling one off and shift-clicking deselects it.
   You can also use the checkboxes or *Select all*. The bar above the table
   shows how many entries will move and the name of the model they'll land in.
4. Hit **Split selected**. The new model appears in the list right after its
   source. You can keep splitting any model, including ones you just created.

   You can also reorder a model's Decoration entries. Drag rows (dragging a
   selected row moves the whole selection) or use the ▲/▼ buttons. The #
   column always shows the current order, and the exported .gia keeps that
   order.

   Dragging rows onto another model in the sidebar moves them into that model,
   appended at the end. The moved decorations' local transforms are
   recalculated against the new model's position, rotation and zoom, so they
   keep their exact world placement. Nothing moves visually, only the parent
   changes. When both models share the same transform, the entries' bytes are
   left untouched and only the parent reference is rewritten. Valid targets
   light up while you drag. The game allows at most 999 entries per model, so
   a move that would push the target past that is rejected: over-limit
   targets dim as soon as the drag starts, turn red on hover, and dropping
   shows a warning while both models stay as they were.

   Rename any model or decoration by double-clicking its name. Or select
   several entries and use **Rename selected** to give them all the same name
   in one step, which you can undo with Ctrl+Z and redo with Ctrl+Y.

   Entity groups: if the file is a prefab or entity group export, the group
   shows up in the Models list with a **group** badge and its member count.
   Opening it lists the member entities, each with its Decoration count and
   entity ID, instead of a Decoration table. Select members and hit
   **Ungroup selected**, or use **Ungroup all**. The chosen entities leave
   the group and appear as ordinary models right after it. Every byte is kept
   except the emptied group membership component. Their world placement does
   not change, because member transforms are stored in world space. Once the
   last member has left, the group entity and its prefab definition are
   removed from the file. Freed members can then be split, renamed, reordered
   and exported like any other model.
5. Choose which models the download includes with the sidebar checkboxes.
   **Select all** and **Deselect all** sit at the top of the Models panel.
   Badges mark new models and models that own a node graph. The selection
   stays until you change it, load another file, or hit Reset. New models are
   included by default.
6. Download the resulting `.gia`, or hit *Reset* to throw away all changes.

## Usage: .gil

1. Drop, pick or paste a `.gil` level. The left panel lists every object that
   has decorations, with search, sorting, and a *Show all objects* option that
   lists the whole level (virtualized so large files stay fast).
2. Click parent objects to check them. A click selects one, Ctrl+click
   toggles, Shift+click selects a range, and the checkboxes always toggle.
   The table shows the focused parent's decorations (name, ID, prefab,
   collision) and can be sorted by any column. In the table a click toggles a
   row without clearing the rest, and Shift+click inverts the whole range from
   the last click.

   Decoration selections survive switching parents. Switching or unchecking
   a parent never drops them. A dot marks sidebar rows that hold selected
   decorations, and the Extraction bar sums up the overall state, for example
   "12 decorations selected across 3 parent objects". *Separate Selected
   Decorations* extracts every selected decoration wherever it lives. In
   `.gia` mode each model remembers its selection the same way.

   You can reorder a parent's decorations by dragging rows. Dragging a
   selected row moves the focused parent's whole selected block. Only the
   parent's decoration id list is rewritten, every other byte survives, and
   the move goes on the same undo/redo stack as extractions. Drag handles only
   appear in file order view. If you sort the table, dragging pauses until you
   return to file order (third click on a column header).

   Rename a decoration by double-clicking its name, or select several and use
   **Rename selected** to give them all the same name in one undoable step.
   Only the name field inside each decoration's name component is rewritten,
   and extracted objects carry the new names.

   Dragging rows onto another world object in the sidebar moves them into
   that object, appended at the end. The two parents' id lists and the moved
   decorations' parent references are rewritten, everything else keeps its
   bytes. The moved decorations' local transforms are recalculated against
   the new parent (the inverse of the game's composition,
   `world = P + R·(S⊙p)`), so they keep their exact world position, rotation
   and scale. Only the parent changes. Parents with identical transforms take
   a byte-preserving fast path. Valid targets light up while you drag. The
   game allows at most 999 decorations per parent, so a move that would push
   the target past that is rejected: over-limit targets dim as soon as the
   drag starts, turn red on hover, and dropping shows a warning while both
   parents stay as they were.
3. Use the **Extraction** bar:
   - **Separate Selected Decorations** extracts exactly the decorations
     selected in the table. Unselected decorations stay attached. The parent's
     decoration list is rewritten, not cleared.
   - **Separate All Decorations from Selected Parents** extracts every
     decoration of the checked parents.

   Two options sit below the buttons and are remembered between visits:
   *Enable Collision for Extracted Objects* (on by default) and *Remove Parent
   Object After Extraction* (off by default). A parent is only deleted if it
   ends up empty and a scan of the whole level finds nothing else that
   references it.
4. Before anything is changed, a review dialog lists warnings. The main one
   is the game's zoom limit: extracted objects whose estimated world scale
   goes above 50 on any axis are listed with their parent and the affected
   axes. Continue or cancel. Cancel changes nothing.
5. Undo and redo (buttons or Ctrl+Z / Ctrl+Y) restore the exact bytes, with
   no limit on the number of steps. Long operations show a progress bar and
   keep the page responsive. An 11 MB level with about 8,000 decorations
   splits in roughly a second.
6. Download the modified `.gil`. A file downloaded without any edits is
   byte-identical to the input.

In both modes the 3D viewer on the right shows the open model's or focused
parent's decorations as points at their world positions. Left-drag draws a
selection box (Ctrl adds, Alt subtracts, Shift toggles), right-drag orbits,
middle-drag pans, and the selection stays in sync with the table in both
directions. The toolbar has search with highlighting, frame selected/all,
grid and axis toggles, labels, point size and colors, hide/isolate buttons,
selection stats with a coordinate readout, and quick view buttons with an
orientation gizmo.

## How .gia splitting works

The splitter never decodes Decoration contents. It does targeted protobuf
edits on the container and copies everything else as is:

- Decoration entries pass through untouched whatever their type or contents.
  Only the parent model reference (component 4/40 field 502) is rewritten for
  entries that move to a new model. That keeps the tool working with
  decoration types it has never seen.
- New models are byte copies of their source model, so all non-Decoration
  data comes along. The exceptions are fields that must stay unique: the copy
  gets a fresh guid and a `_2`/`_3`… name, and only the moved decorations'
  references. A node graph binding can belong to one model only, so it stays
  with the source.
- Ordering: each model's Decoration list (component 6/40 field 501) keeps its
  entries in the original relative order after every split. Manual reordering
  rewrites only that list. Every Decoration entry keeps its bytes, so all
  metadata stays attached to the same decoration.
- Entries the tool doesn't understand (node graphs, unknown classes, unknown
  fields at any level) are written out exactly as they came in. A file
  exported without any splits is byte-identical to the input.
- Selective export: deselected models are left out together with their
  Decoration entries. Non-decoration entries (node graphs, unknown classes)
  are always kept, even when every model that references them is excluded.
  Nothing outside the Decoration lists is ever silently dropped. Every model
  and entry that stays in the export is written exactly as a full export
  would write it.
- The engine handles both model entry layouts seen so far (generated class-1
  models and class-3 game objects such as Empty Models), so files with either
  kind load and split correctly.
- The 3D viewer only reads decoration positions for display. Nothing it does
  feeds back into serialization, so it can't affect byte preservation.

## How .gil extraction works

The `.gil` engine lives in `js/gil/` and has been checked byte for byte
against files the game itself produced. It changes only three top-level
containers: world objects, registry, and decorations. Everything else,
including unknown fields, is kept exactly.

- Transforms are composed as `worldPos = parentPos + parentRot × (parentScale
  ⊙ localPos)`, `worldRot = parentRot ∘ localRot` (Euler Z-X-Y degrees), and
  `worldScale = parentScale ⊙ localScale`. The results match game-authored
  reference output bit for bit in float32.
- New object ids follow the game's own allocation: highest existing id in the
  `0x4040xxxx` space plus one. The new objects are added to the level's
  world object registry group.
- A parent loses exactly one thing: the extracted ids from its decoration id
  list. Parent removal is gated by a single pass reference scan over the
  whole level.
- Undo/redo snapshots are zero-copy references to the three containers' raw
  bytes. Restoring a pre-edit snapshot reproduces the original file
  byte-identically.

## Localization

- `js/i18n.js` is a small system with no dependencies: `t(key, params)`,
  plural-aware `tn(key, n)` (via `Intl.PluralRules`), locale number
  formatting `num()` (via `Intl.NumberFormat`), `data-i18n` /
  `data-i18n-title` / `data-i18n-placeholder` bindings for static DOM, and an
  `onLangChange` hook that re-renders dynamic UI. Switching languages never
  reloads the page. Labels that depend on the mode use `data-i18n-gil`
  overrides on the same elements.
- English ships in the bundle and is the fallback for every key, so a missing
  translation shows English rather than a raw key or a blank.
- Other locales load on demand from `js/locales/<code>.js`. Adding a language
  means adding one file and one row in `LANGS`. No application code changes.
- The saved choice persists in localStorage under the shared `miliastra-lang`
  key and syncs live across toolkit sites and tabs. On first visit the
  language is detected from the browser, including telling zh-Hans and
  zh-Hant apart.
- Engine errors carry i18n codes (`err.i18n`) so validation messages are
  localized while logs and tests keep English text. `.gil` warning and error
  codes map to `gil.w.*` / `gil.e.*` keys.
- Font stacks cover Latin, Cyrillic, Vietnamese, CJK and Thai on all major
  OSes, with per-language `:lang()` preferences and extra line height for
  Thai. Layouts wrap for long German and Russian strings.

## Project layout

| Path | Role |
|---|---|
| `index.html`, `css/style.css` | UI shell (master-detail: object/model list plus decoration table), adapts to the mode via `body.mode-gia` / `body.mode-gil` |
| `js/app.js` | app logic for both modes (import, select, split or extract, download) |
| `js/gia-splitter.js` | `GiaSession`, the byte-preserving .gia split engine (self-contained, no dependencies) |
| `js/gil-splitter.js` | `GilSession`, the .gil session wrapper (views, operations, zero-copy undo/redo) |
| `js/gil/` | the verified .gil engine: wire format (`gil.js`), level model (`model.js`), extraction (`split.js`). Do not modify. |
| `js/viewer3d.js` | 3D decoration viewer (three.js points, box selection, camera tools), shared by both modes |
| `js/i18n.js`, `js/locales/*.js` | localization system and the 15 language dictionaries |
| `tools/test-splitter.mjs` | .gia test suite (`node tools/test-splitter.mjs`) |
| `tools/test-gil.mjs` | .gil engine test suite (`node tools/test-gil.mjs`) |
| `tools/gia-parser.js` | older geometry-aware parser, used only as an independent cross-check in tests |
| `reference/` | format handoff docs and sample .gia/.gil fixtures |

Format details are in
[reference/docs/HANDOFF-gia-splitter.md](reference/docs/HANDOFF-gia-splitter.md)
for .gia, and in `GIL-FORMAT.md` in the original `SplitGilDecorations`
project for .gil.

## Run locally

Any static file server works. ES modules don't load from `file://`, so you
need one:

```sh
npx http-server -p 8123 .
# then open http://localhost:8123
```

There is no build step. The only dependency is three.js, loaded from the
jsDelivr CDN through an import map, and it is only used by the 3D viewer.

## Tests

```sh
node tools/test-splitter.mjs
node tools/test-gil.mjs
node tools/test-reparent.mjs
```

`test-splitter.mjs` runs against the sample fixtures and checks: lossless
protobuf re-encoding, byte-identical no-op serialization, order preservation
for scattered selections, parent reference correctness, byte identity of node
graphs and unmoved Decoration entries, repeated splits, selective export,
reordering, class-3 game object files, rename and cross-model moves, and edge
cases such as moving every entry out of a model.

`test-reparent.mjs` checks that cross-parent moves keep world-space
transforms in both formats: rotated and zoomed parents, multi-selection
moves, no drift after repeated reparenting, exact undo, byte restoration when
moving back, and reloaded files passing the same checks.

`test-gil.mjs` runs against the sample `.gil` fixtures and checks: byte for
byte round trips, split output against game-authored standalone counterparts
(bit-exact world transforms), minimal parent mutation, registry updates, id
allocation, collision encoding, parent removal reference safety, and the zoom
limit warning. Pass a directory argument to use other reference files. The
11 MB performance section only runs when `Cozy Disc Golf.gil` is present.

## Deploy to GitHub Pages

```sh
git init
git add .
git commit -m "GIA / GIL Splitter"
git branch -M main
git remote add origin https://github.com/<you>/<repo>.git
git push -u origin main
```

Then on GitHub go to Settings, Pages, and set Source to "Deploy from a
branch" with branch `main` and folder root. The site will be live at
`https://<you>.github.io/<repo>/` a minute later.
