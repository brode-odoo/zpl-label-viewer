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
| <kbd>Ctrl</kbd>+<kbd>S</kbd> | Download PNG |
| <kbd>Esc</kbd> | Close the viewer, show the original page |
| <kbd>Tab</kbd> | Indent (does not move focus) |

Controls in the toolbar: print density (6/8/12/24 dpmm — 8 dpmm = 203 dpi is the
usual Zebra desktop printer), label size in inches (presets + custom), rotation,
zoom, PNG download, PDF, and print. If the ZPL contains several `^XA…^XZ` blocks
a pager appears to step through the labels.

Density, size, rotation and the Live toggle are remembered across sessions
(`chrome.storage.sync`).

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
| `content.js` | ZPL detection, the shadow-DOM viewer UI, export/print actions |
| `background.js` | Labelary calls, toolbar-icon and keyboard-shortcut toggle |
| `viewer.css` | Viewer styles (fetched into the shadow root) |
| `icons/` | Toolbar icons |

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
