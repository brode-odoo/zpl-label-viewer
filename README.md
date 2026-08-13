# ZPL Label Viewer

A Chrome extension for the Odoo label-template workflow: when a page is raw ZPL
(e.g. `http://<host>/report/html/stock.label_package_template_view/<id>`), it takes
the page over and shows the **rendered label** instead of the code — with the ZPL
in an editable pane next to it so you can tune `^FO` offsets, barcode sizes and
fonts and watch the label update as you type.

## Install

1. Open `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. **Load unpacked** → pick this folder (`zpl-label-viewer`)

## Use

- Open any Odoo ZPL report page — the viewer opens automatically.
- On any other page (or if auto-detect passes on it): click the toolbar icon or
  press <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>Z</kbd>. If you have ZPL selected on
  the page, that selection is loaded; otherwise you get an empty editor to paste into.
- Edit the ZPL on the left. With **Live** on it re-renders ~0.6 s after you stop
  typing; otherwise hit **Render** / <kbd>Ctrl</kbd>+<kbd>Enter</kbd>.
- **Copy ZPL** puts the edited code on the clipboard, ready to paste back into the
  Odoo QWeb template.

| Key | Action |
| --- | --- |
| <kbd>Ctrl</kbd>+<kbd>Enter</kbd> | Render |
| <kbd>Shift</kbd>+<kbd>Alt</kbd>+<kbd>F</kbd> | Format the ZPL |
| <kbd>Ctrl</kbd>+<kbd>S</kbd> | Download PNG |
| <kbd>←↑↓→</kbd> | Nudge the selected field (<kbd>Shift</kbd> = ×10) |
| <kbd>Delete</kbd> | Delete the selected field |
| <kbd>Esc</kbd> | Close the viewer, show the original page |
| <kbd>Tab</kbd> | Indent (does not move focus) |

Controls in the toolbar: print density (6/8/12/24 dpmm — 8 dpmm = 203 dpi is the
usual Zebra desktop printer), label size in inches (presets + custom), rotation,
zoom, PNG download, PDF, and print. If the ZPL contains several `^XA…^XZ` blocks
a pager appears to step through the labels.

Density, size, rotation, snap and the Live/Auto-format toggles are remembered
across sessions (`chrome.storage.sync`).

## Design tab

The left pane has two tabs. **ZPL** is the raw code; **Design** is a visual editor
laid over the real rendered label:

- Every `^FO`/`^FT` field gets a draggable outline on the preview. Drag to move,
  arrow-keys to nudge, and **Snap** in the toolbar quantises to 1/5/10/25 dots.
- Drag a **Text**, **Barcode**, **QR code**, **Box** or **Line** block from the palette
  onto the label to add it where you dropped it.
- Selecting a field opens an inspector: text content and font size for text;
  data, symbology, height, module width and human-readable line for barcodes;
  width/height/thickness/corner radius for boxes (boxes also get a drag-to-resize
  grip). Plus Duplicate and Delete.

The outlines are *estimated* from the ZPL — the actual render underneath is the
truth. Text and barcode extents are computed from font size, module width and data
length, which is close but not exact; they only need to be good enough to grab.

### It edits the code, not a model of it

The ZPL text stays the source of truth. The designer parses it, and each gesture
patches only the command it concerns — a drag rewrites the `^FO` parameters and
nothing else. Commands it has no UI for (`^FR`, `^FB`, `^CI`, `^CF`, comments,
vendor extensions) pass through untouched, as does your formatting, so a field
like `^FO50,50^FR^FB400,3,0,C^A0N,30,30^FD…^FS` can still be dragged around
without losing the reverse-print or field-block settings.

## Formatting

**Format** (or <kbd>Shift</kbd>+<kbd>Alt</kbd>+<kbd>F</kbd>) rewrites the ZPL as one
field per line, indented inside `^XA`…`^XZ`, with a blank line between labels:

```
^XA
  ^FO60,40^A0N,60,33^FDPACK0000001^FS
  ^FO60,140^BY4^BCN,140,Y,N,N^FDPACK0000001^FS
^XZ
```

It rebuilds from parsed tokens rather than by regex, so whitespace *inside* `^FD`
data — spaces and newlines that the label actually prints — is preserved exactly.
It is idempotent. Tick **Auto-format** to have it run every time the viewer opens.

## How rendering works

The ZPL is POSTed to the public [Labelary](https://labelary.com/service.html) API
(`https://api.labelary.com/v1/printers/{dpmm}dpmm/labels/{w}x{h}/{index}/`) and the
returned PNG/PDF is displayed. **Your label content leaves the machine and goes to
labelary.com** — fine for package barcodes, worth knowing if a template ever carries
customer data. Labelary's linter is enabled, so warnings about the ZPL show up in an
amber strip under the preview.

The call is made from the service worker, not the content script, because a content
script's `fetch` is bound by the host page's CORS rules and cannot read the
`X-Total-Count` / `X-Warnings` response headers.

Rate limit is 5 requests/second; a `429` is retried once after `Retry-After`.

## Files

| File | Role |
| --- | --- |
| `manifest.json` | MV3 manifest — content script on all URLs, `api.labelary.com` host permission |
| `zpl-model.js` | ZPL tokenizer, field parser, command-level patching, formatter |
| `designer.js` | Palette, draggable field outlines, property inspector |
| `content.js` | ZPL detection, the shadow-DOM viewer UI, export/print actions |
| `background.js` | Labelary calls, toolbar-icon and keyboard-shortcut toggle |
| `viewer.css` | Viewer styles (fetched into the shadow root) |
| `icons/` | Toolbar icons |
| `test/model.test.js` | `node test/model.test.js` — parser, patching and formatter checks (no deps) |

## Narrowing the permissions

The content script is registered for `<all_urls>` so it can auto-detect anywhere.
To limit it to your Odoo host, change `matches` in `manifest.json`:

```json
"matches": ["http://localhost:PORT/*"]
```

The toolbar icon still works elsewhere via `activeTab` + `scripting`.

## Detection rule

The viewer only takes a page over on its own when the ZPL *is* the page: text
inside a `<pre>`/`<plaintext>`, or body text that starts with `^XA` or is more than
half `^XA…^XZ`. A page that merely quotes ZPL (docs, a code review) is left alone —
use the toolbar icon there.
