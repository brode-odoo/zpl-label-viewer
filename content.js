/**
 * Finds raw ZPL on the page and puts a rendered label over it, with the code
 * in an editable pane so a template can be tweaked and re-rendered instantly.
 */

(() => {
  if (window.__zplLabelViewer) return;

  const HOST_ID = 'zpl-label-viewer-host';
  const BLOCK_RE = /\^XA[\s\S]*?\^XZ/gi;
  const HAS_ZPL_RE = /\^XA[\s\S]*?\^XZ/i;

  const DEFAULTS = {
    dpmm: 8,
    width: 4,
    height: 6,
    rotation: 0,
    autoOpen: true,
    live: true,
    fit: true,
    tab: 'design',
    snap: 5,
    autoFormat: false
  };

  const SIZES = [
    [4, 6],
    [4, 4],
    [4, 3],
    [4, 2],
    [4, 1],
    [3, 2],
    [3, 1],
    [2.25, 1.25],
    [2, 1],
    [1.5, 1]
  ];

  const state = {
    settings: { ...DEFAULTS },
    index: 0,
    total: 1,
    zoom: 1,
    lastBlob: null,
    lastMime: 'image/png',
    open: false,
    seq: 0
  };

  let ui = null;
  let designer = null;
  let debounce = null;

  const api = {
    toggle,
    open: openViewer,
    close: closeViewer
  };
  window.__zplLabelViewer = api;

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg && msg.type === 'toggle') {
      toggle();
      sendResponse({ ok: true });
    }
    return false;
  });

  init();

  async function init() {
    state.settings = await loadSettings();
    if (!state.settings.autoOpen) return;
    const found = detect();
    if (found && found.confident) openViewer(found.zpl);
  }

  /* ------------------------------------------------------------------ *
   * detection
   * ------------------------------------------------------------------ */

  function detect() {
    // A <pre> is what Chrome builds for a text/plain response, and what most
    // report viewers use — trust it outright.
    const pre = Array.from(document.querySelectorAll('pre, plaintext, xmp'))
      .map((n) => n.textContent || '')
      .filter((t) => HAS_ZPL_RE.test(t))
      .sort((a, b) => b.length - a.length)[0];
    if (pre) return { zpl: joinBlocks(pre), confident: true };

    const selection = String(window.getSelection() || '');
    if (HAS_ZPL_RE.test(selection)) return { zpl: joinBlocks(selection), confident: false };

    const text = document.body ? document.body.innerText || '' : '';
    const zpl = joinBlocks(text);
    if (!zpl) return null;

    // Only take over the page when the ZPL *is* the page — otherwise a wiki
    // article or a code review that happens to quote ZPL would get hijacked.
    const ratio = zpl.length / Math.max(text.trim().length, 1);
    return { zpl, confident: /^\s*\^XA/.test(text) || ratio > 0.5 };
  }

  function joinBlocks(text) {
    const blocks = String(text || '').match(BLOCK_RE);
    return blocks ? blocks.join('\n\n') : '';
  }

  /* ------------------------------------------------------------------ *
   * open / close
   * ------------------------------------------------------------------ */

  function toggle() {
    if (state.open) {
      closeViewer();
    } else {
      const found = detect();
      openViewer(found ? found.zpl : '');
    }
  }

  async function openViewer(zpl) {
    if (!ui) ui = await buildUI();
    if (typeof zpl === 'string' && (zpl || !ui.code.value)) ui.code.value = zpl;
    if (state.settings.autoFormat && ui.code.value.trim()) {
      ui.code.value = window.__zplModel.format(ui.code.value) || ui.code.value;
    }
    updateEditorStatus(ui);
    state.index = 0;
    state.open = true;
    ui.host.style.setProperty('display', 'block', 'important');
    document.documentElement.style.setProperty('overflow', 'hidden', 'important');
    ui.code.focus();
    ui.code.setSelectionRange(0, 0);
    if (ui.code.value.trim()) render();
    else showPlaceholder();
  }

  function closeViewer() {
    state.open = false;
    if (ui) ui.host.style.setProperty('display', 'none', 'important');
    document.documentElement.style.removeProperty('overflow');
  }

  /* ------------------------------------------------------------------ *
   * UI
   * ------------------------------------------------------------------ */

  async function buildUI() {
    const css = await loadCss();

    const host = document.createElement('div');
    host.id = HOST_ID;
    // Set individually rather than via `all`, so the display toggle below can
    // still win against the host page's stylesheet.
    host.style.setProperty('position', 'fixed', 'important');
    host.style.setProperty('inset', '0', 'important');
    host.style.setProperty('z-index', '2147483647', 'important');
    host.style.setProperty('display', 'block', 'important');
    const root = host.attachShadow({ mode: 'open' });

    const sizeOptions = SIZES.map(
      ([w, h]) => `<option value="${w}x${h}">${w}" × ${h}"</option>`
    ).join('');

    root.innerHTML = `
      <style>${css}</style>
      <div class="wrap">
        <div class="bar">
          <div class="brand"><span class="dot" id="dot"></span><span>ZPL Label Viewer</span></div>

          <div class="group">
            <label for="dpmm">Density</label>
            <select id="dpmm">
              <option value="6">6 dpmm · 152 dpi</option>
              <option value="8">8 dpmm · 203 dpi</option>
              <option value="12">12 dpmm · 300 dpi</option>
              <option value="24">24 dpmm · 600 dpi</option>
            </select>
          </div>

          <div class="group">
            <label for="size">Size</label>
            <select id="size">${sizeOptions}<option value="custom">Custom…</option></select>
            <input id="w" type="number" step="0.05" min="0.1" max="15" title="Width (inches)">
            <span>×</span>
            <input id="h" type="number" step="0.05" min="0.1" max="15" title="Height (inches)">
          </div>

          <div class="group">
            <label for="rot">Rotate</label>
            <select id="rot">
              <option value="0">0°</option>
              <option value="90">90°</option>
              <option value="180">180°</option>
              <option value="270">270°</option>
            </select>
          </div>

          <div class="group" id="pager">
            <button class="icon" id="prev" title="Previous label">‹</button>
            <span id="pageLabel">1 / 1</span>
            <button class="icon" id="next" title="Next label">›</button>
          </div>

          <div class="group">
            <button class="icon" id="zoomOut" title="Zoom out">−</button>
            <button id="zoomFit" title="Toggle fit / actual size">Fit</button>
            <button class="icon" id="zoomIn" title="Zoom in">+</button>
          </div>

          <div class="group" id="snapGroup">
            <label for="snap">Snap</label>
            <select id="snap">
              <option value="1">1 dot</option>
              <option value="5">5 dots</option>
              <option value="10">10 dots</option>
              <option value="25">25 dots</option>
            </select>
          </div>

          <div class="spacer"></div>

          <label class="group" title="Re-render as you type">
            <input type="checkbox" id="live"> <span>Live</span>
          </label>
          <button id="format" title="Tidy the ZPL: one field per line (Shift+Alt+F)">Format</button>
          <button class="primary" id="render" title="Render (Ctrl+Enter)">Render</button>
          <button id="copy" title="Copy the ZPL back to the clipboard">Copy ZPL</button>
          <button id="png" title="Download the rendered label as PNG">PNG</button>
          <button id="pdf" title="Open the label as a PDF">PDF</button>
          <button id="print" title="Print the label">Print</button>
          <button class="close" id="close" title="Close and show the page (Esc)">✕</button>
        </div>

        <div class="panes">
          <div class="pane editor">
            <div class="pane-head tabs">
              <button class="tab" id="tabDesign" data-tab="design">Design</button>
              <button class="tab" id="tabZpl" data-tab="zpl">ZPL</button>
              <span class="spacer"></span>
              <label class="mini" title="Format the ZPL every time the viewer opens">
                <input type="checkbox" id="autoFormat"> <span>Auto-format</span>
              </label>
            </div>
            <div class="designBody" id="designBody">
              <div id="palette"></div>
              <div id="inspector"></div>
            </div>
            <textarea id="code" spellcheck="false" wrap="off"
              placeholder="^XA … ^XZ"></textarea>
            <div class="status" id="editorStatus"></div>
          </div>

          <div class="pane preview">
            <div class="pane-head">
              <span>Preview</span>
              <span class="spacer"></span>
              <span class="hint" id="hint"></span>
            </div>
            <div class="stage fit" id="stage">
              <div class="placeholder" id="placeholder">Paste or edit ZPL on the left, then hit Render.</div>
            </div>
            <div class="warn" id="warn" style="display:none"></div>
            <div class="status" id="status"></div>
          </div>
        </div>
      </div>
    `;

    (document.body || document.documentElement).appendChild(host);

    const $ = (id) => root.getElementById(id);
    const u = {
      host,
      root,
      dot: $('dot'),
      dpmm: $('dpmm'),
      size: $('size'),
      w: $('w'),
      h: $('h'),
      rot: $('rot'),
      pager: $('pager'),
      prev: $('prev'),
      next: $('next'),
      pageLabel: $('pageLabel'),
      zoomIn: $('zoomIn'),
      zoomOut: $('zoomOut'),
      zoomFit: $('zoomFit'),
      live: $('live'),
      snap: $('snap'),
      snapGroup: $('snapGroup'),
      autoFormat: $('autoFormat'),
      tabDesign: $('tabDesign'),
      tabZpl: $('tabZpl'),
      designBody: $('designBody'),
      palette: $('palette'),
      inspector: $('inspector'),
      hint: $('hint'),
      wrap: root.querySelector('.wrap'),
      code: $('code'),
      stage: $('stage'),
      placeholder: $('placeholder'),
      warn: $('warn'),
      status: $('status'),
      editorStatus: $('editorStatus'),
      btnRender: $('render'),
      btnCopy: $('copy'),
      btnPng: $('png'),
      btnPdf: $('pdf'),
      btnPrint: $('print'),
      btnFormat: $('format'),
      btnClose: $('close')
    };

    // --- reflect settings into the controls
    u.dpmm.value = String(state.settings.dpmm);
    u.w.value = state.settings.width;
    u.h.value = state.settings.height;
    u.rot.value = String(state.settings.rotation);
    u.live.checked = !!state.settings.live;
    syncSizeSelect(u);
    u.zoomFit.textContent = state.settings.fit ? 'Fit' : '100%';
    u.snap.value = String(state.settings.snap);
    u.autoFormat.checked = !!state.settings.autoFormat;
    u.pager.style.display = 'none'; // shown once a multi-label render comes back

    designer = window.__zplDesigner({
      wrap: u.wrap,
      palette: u.palette,
      inspector: u.inspector,
      hint: u.hint,
      getZpl: () => u.code.value,
      setZpl: (v) => {
        u.code.value = v;
        updateEditorStatus(u);
      },
      getLabelIndex: () => state.index,
      getView: () => ({
        img: u.stage.querySelector('img'),
        overlay: u.stage.querySelector('.overlay')
      }),
      requestRender: () => scheduleRender()
    });
    designer.setSnap(state.settings.snap);

    // --- wiring
    u.dpmm.addEventListener('change', () => {
      state.settings.dpmm = Number(u.dpmm.value);
      saveSettings();
      render();
    });

    u.size.addEventListener('change', () => {
      if (u.size.value !== 'custom') {
        const [w, h] = u.size.value.split('x');
        u.w.value = w;
        u.h.value = h;
      }
      commitSize(u);
    });

    [u.w, u.h].forEach((el) =>
      el.addEventListener('change', () => {
        syncSizeSelect(u);
        commitSize(u);
      })
    );

    u.rot.addEventListener('change', () => {
      state.settings.rotation = Number(u.rot.value);
      saveSettings();
      render();
    });

    u.live.addEventListener('change', () => {
      state.settings.live = u.live.checked;
      saveSettings();
    });

    u.prev.addEventListener('click', () => gotoLabel(state.index - 1));
    u.next.addEventListener('click', () => gotoLabel(state.index + 1));

    u.zoomIn.addEventListener('click', () => setZoom(state.zoom * 1.25));
    u.zoomOut.addEventListener('click', () => setZoom(state.zoom / 1.25));
    u.zoomFit.addEventListener('click', () => {
      state.settings.fit = !state.settings.fit;
      state.zoom = 1;
      saveSettings();
      applyZoom();
    });

    u.tabDesign.addEventListener('click', () => setTab('design'));
    u.tabZpl.addEventListener('click', () => setTab('zpl'));

    u.snap.addEventListener('change', () => {
      state.settings.snap = Number(u.snap.value) || 1;
      designer.setSnap(state.settings.snap);
      saveSettings();
    });

    u.autoFormat.addEventListener('change', () => {
      state.settings.autoFormat = u.autoFormat.checked;
      saveSettings();
    });

    u.btnFormat.addEventListener('click', formatCode);
    u.btnRender.addEventListener('click', () => render());
    u.btnClose.addEventListener('click', closeViewer);
    u.btnCopy.addEventListener('click', copyZpl);
    u.btnPng.addEventListener('click', downloadPng);
    u.btnPdf.addEventListener('click', openPdf);
    u.btnPrint.addEventListener('click', printLabel);

    u.code.addEventListener('input', () => {
      updateEditorStatus(u);
      designer.refresh();
      if (u.live.checked) scheduleRender(600);
    });

    u.stage.addEventListener('pointerdown', (e) => {
      if (e.target === u.stage || e.target.classList.contains('overlay')) designer.clearSelection();
    });

    window.addEventListener('resize', () => designer && designer.drawOverlay());

    // Keep the host page (Odoo binds plenty of shortcuts) out of our keys.
    root.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (designer && designer.handleKey(e)) {
        e.preventDefault();
        return;
      }
      if (e.code === 'KeyF' && e.altKey && e.shiftKey) {
        e.preventDefault();
        formatCode();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        closeViewer();
      } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        clearTimeout(debounce);
        render();
      } else if (e.key.toLowerCase() === 's' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        downloadPng();
      } else if (e.key === 'Tab' && e.target === u.code) {
        e.preventDefault();
        insertAtCursor(u.code, '    ');
      }
    });

    updateEditorStatus(u);
    ui = u; // setTab/formatCode read through the module-level handle
    setTab(state.settings.tab);
    return u;
  }

  function setTab(tab) {
    if (!ui) return;
    state.settings.tab = tab === 'zpl' ? 'zpl' : 'design';
    const design = state.settings.tab === 'design';
    ui.designBody.style.display = design ? '' : 'none';
    ui.code.style.display = design ? 'none' : '';
    ui.tabDesign.classList.toggle('on', design);
    ui.tabZpl.classList.toggle('on', !design);
    ui.snapGroup.style.display = design ? '' : 'none';
    if (designer) {
      designer.setActive(design);
      if (design) designer.refresh();
    }
    saveSettings();
  }

  function formatCode() {
    if (!ui) return;
    const out = window.__zplModel.format(ui.code.value);
    if (!out || out === ui.code.value) return;
    ui.code.value = out;
    updateEditorStatus(ui);
    if (designer) designer.refresh(); // field offsets all moved
    flash(ui.btnFormat, 'Formatted');
  }

  function scheduleRender(delay) {
    clearTimeout(debounce);
    debounce = setTimeout(() => render(), delay || 350);
  }

  async function loadCss() {
    try {
      const res = await fetch(chrome.runtime.getURL('viewer.css'));
      if (res.ok) return await res.text();
    } catch (e) {
      /* fall through */
    }
    // Minimal fallback so the viewer is still usable if the page blocks the
    // stylesheet fetch.
    return `:host{all:initial}*{box-sizing:border-box}
      .wrap{position:fixed;inset:0;display:flex;flex-direction:column;background:#16171b;color:#e6e8ee;font:13px sans-serif}
      .bar{display:flex;flex-wrap:wrap;gap:8px;padding:8px;background:#1e2027}
      .panes{flex:1;display:flex;min-height:0}
      .pane{display:flex;flex-direction:column;min-height:0}
      .pane.editor{width:42%}.pane.preview{flex:1;background:#101116}
      textarea{flex:1;width:100%;background:#16171b;color:#d7dbe6;font-family:monospace;border:0;padding:10px}
      .stage{flex:1;overflow:auto;display:flex;justify-content:center;padding:16px}
      .sheet{background:#fff;position:relative}.sheet img{display:block;max-width:100%}
      .overlay{position:absolute;inset:0}
      .el{position:absolute;border:1px dashed #2f6df6;background:rgba(47,109,246,.08);cursor:move}
      .el.sel{border-style:solid;background:rgba(47,109,246,.18)}
      .el .tag{display:none}.el .grip{position:absolute;right:-5px;bottom:-5px;width:10px;height:10px;background:#35c88a}
      .designBody{flex:1;overflow:auto;padding:12px}
      .palette{display:grid;grid-template-columns:repeat(auto-fill,minmax(84px,1fr));gap:8px;margin-bottom:12px}
      .block{padding:8px;cursor:grab}.fld{display:flex;flex-direction:column;gap:4px;margin-bottom:8px;font-size:11.5px}
      .grid2{display:grid;grid-template-columns:1fr 1fr;gap:0 8px}.row-btns{display:flex;gap:8px}
      .tab{background:transparent;border:0;padding:8px 12px}.tab.on{color:#fff;border-bottom:2px solid #2f6df6}
      .status{padding:6px 10px;color:#8a91a2}.status.error{color:#ffb3b3;white-space:pre-wrap}
      .warn{padding:6px 10px;color:#ffd489;background:#2b2517}
      .spacer{flex:1}`;
  }

  function syncSizeSelect(u) {
    const key = `${Number(u.w.value)}x${Number(u.h.value)}`;
    const match = Array.from(u.size.options).some((o) => o.value === key);
    u.size.value = match ? key : 'custom';
  }

  function commitSize(u) {
    state.settings.width = Number(u.w.value) || 4;
    state.settings.height = Number(u.h.value) || 6;
    saveSettings();
    render();
  }

  function insertAtCursor(el, text) {
    const { selectionStart: s, selectionEnd: e, value } = el;
    el.value = value.slice(0, s) + text + value.slice(e);
    el.selectionStart = el.selectionEnd = s + text.length;
  }

  function updateEditorStatus(u) {
    const v = u.code.value;
    const labels = (v.match(BLOCK_RE) || []).length;
    u.editorStatus.textContent = `${v.length.toLocaleString()} chars · ${v.split('\n').length} lines · ${labels} ^XA…^XZ block${labels === 1 ? '' : 's'}`;
  }

  /* ------------------------------------------------------------------ *
   * rendering
   * ------------------------------------------------------------------ */

  function gotoLabel(i) {
    if (i < 0 || i >= state.total) return;
    state.index = i;
    render();
  }

  function render(format) {
    if (!ui) return Promise.resolve(null);
    const zpl = ui.code.value;
    if (!zpl.trim()) {
      showPlaceholder();
      return Promise.resolve(null);
    }

    const isPreview = !format;
    const seq = ++state.seq;
    if (isPreview) setBusy(true);

    return new Promise((resolve) => {
      chrome.runtime.sendMessage(
        {
          type: 'render',
          options: {
            zpl,
            dpmm: state.settings.dpmm,
            width: state.settings.width,
            height: state.settings.height,
            rotation: state.settings.rotation,
            index: state.index,
            format: format || 'png'
          }
        },
        (res) => {
          if (chrome.runtime.lastError) {
            if (isPreview) fail(`Extension link lost: ${chrome.runtime.lastError.message}. Reload the page.`);
            return resolve(null);
          }
          if (!res || !res.ok) {
            if (isPreview) fail((res && res.error) || 'Render failed.');
            else fail((res && res.error) || 'Export failed.');
            return resolve(null);
          }
          if (isPreview) {
            if (seq !== state.seq) return resolve(res); // a newer render already landed
            showResult(res);
          }
          resolve(res);
        }
      );
    });
  }

  function showResult(res) {
    setBusy(false);
    state.total = res.total || 1;
    state.lastBlob = dataUrlToBlob(res.dataUrl);
    state.lastMime = res.mime;

    const url = URL.createObjectURL(state.lastBlob);
    const img = new Image();
    img.onload = () => {
      ui.stage.innerHTML = '';
      const sheet = document.createElement('div');
      sheet.className = 'sheet';
      const overlay = document.createElement('div');
      overlay.className = 'overlay';
      sheet.appendChild(img);
      sheet.appendChild(overlay);
      ui.stage.appendChild(sheet);
      applyZoom();
      designer.refresh();
      const dpi = state.settings.dpmm * 25.4;
      ui.status.className = 'status';
      ui.status.textContent =
        `${img.naturalWidth} × ${img.naturalHeight} px · ` +
        `${state.settings.width}" × ${state.settings.height}" at ${state.settings.dpmm} dpmm (${Math.round(dpi)} dpi)` +
        (state.settings.rotation ? ` · rotated ${state.settings.rotation}°` : '');
    };
    img.onerror = () => {
      fail('The rendered image could not be displayed on this page (its content security policy blocked it). Use the PNG button to download it instead.');
    };
    img.src = url;

    ui.pageLabel.textContent = `${state.index + 1} / ${state.total}`;
    ui.prev.disabled = state.index <= 0;
    ui.next.disabled = state.index >= state.total - 1;
    ui.pager.style.display = state.total > 1 ? '' : 'none';

    showWarnings(res.warnings);
  }

  function showWarnings(raw) {
    if (!raw) {
      ui.warn.style.display = 'none';
      ui.warn.textContent = '';
      return;
    }
    const items = String(raw)
      .split(/\s*\|\s*|\n/)
      .map((s) => s.trim())
      .filter(Boolean);
    ui.warn.innerHTML =
      `<strong>Linter warnings</strong><ul>${items.map((t) => `<li>${escapeHtml(t)}</li>`).join('')}</ul>`;
    ui.warn.style.display = '';
  }

  function showPlaceholder() {
    setBusy(false);
    ui.stage.innerHTML = '<div class="placeholder">Paste or edit ZPL on the left, then hit Render.</div>';
    ui.status.className = 'status';
    ui.status.textContent = '';
    ui.warn.style.display = 'none';
  }

  function setBusy(busy) {
    ui.dot.className = busy ? 'dot busy' : 'dot';
    ui.btnRender.disabled = busy;
    if (busy) {
      ui.status.className = 'status';
      ui.status.textContent = 'Rendering…';
    }
  }

  function fail(message) {
    ui.dot.className = 'dot err';
    ui.btnRender.disabled = false;
    ui.status.className = 'status error';
    ui.status.textContent = message;
  }

  /* ------------------------------------------------------------------ *
   * zoom
   * ------------------------------------------------------------------ */

  function setZoom(z) {
    state.settings.fit = false;
    state.zoom = Math.min(8, Math.max(0.1, z));
    ui.zoomFit.textContent = '100%';
    saveSettings();
    applyZoom();
  }

  function applyZoom() {
    const img = ui.stage.querySelector('img');
    ui.zoomFit.textContent = state.settings.fit ? 'Fit' : `${Math.round(state.zoom * 100)}%`;
    ui.stage.classList.toggle('fit', state.settings.fit);
    if (!img) return;
    if (state.settings.fit) {
      img.style.width = '';
      img.style.height = '';
    } else {
      img.style.width = `${Math.round(img.naturalWidth * state.zoom)}px`;
      img.style.height = 'auto';
    }
    // The overlay is positioned in screen pixels, so it has to follow the image.
    if (designer) requestAnimationFrame(() => designer.drawOverlay());
  }

  /* ------------------------------------------------------------------ *
   * export actions
   * ------------------------------------------------------------------ */

  async function copyZpl() {
    const text = ui.code.value;
    try {
      await navigator.clipboard.writeText(text);
      flash(ui.btnCopy, 'Copied!');
    } catch (e) {
      ui.code.select();
      document.execCommand('copy');
      flash(ui.btnCopy, 'Copied!');
    }
  }

  function downloadPng() {
    if (!state.lastBlob) return;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(state.lastBlob);
    a.download = `label-${state.index + 1}.png`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  }

  async function openPdf() {
    const res = await render('pdf');
    if (!res) return;
    const url = URL.createObjectURL(dataUrlToBlob(res.dataUrl));
    window.open(url, '_blank');
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  function printLabel() {
    if (!state.lastBlob) return;
    const url = URL.createObjectURL(state.lastBlob);
    const frame = document.createElement('iframe');
    frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;';
    frame.srcdoc = `<style>@page{margin:0}body{margin:0}img{width:100%}</style><img src="${url}">`;
    frame.onload = () => {
      const win = frame.contentWindow;
      const img = win.document.images[0];
      const go = () => {
        win.focus();
        win.print();
        setTimeout(() => {
          frame.remove();
          URL.revokeObjectURL(url);
        }, 1000);
      };
      if (img && !img.complete) img.onload = go;
      else go();
    };
    document.body.appendChild(frame);
  }

  function flash(btn, text) {
    const old = btn.textContent;
    btn.textContent = text;
    setTimeout(() => (btn.textContent = old), 1200);
  }

  /* ------------------------------------------------------------------ *
   * helpers
   * ------------------------------------------------------------------ */

  function dataUrlToBlob(dataUrl) {
    const [head, b64] = dataUrl.split(',');
    const mime = /:(.*?);/.exec(head)[1];
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: mime });
  }

  function escapeHtml(s) {
    return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  }

  function loadSettings() {
    return new Promise((resolve) => {
      try {
        chrome.storage.sync.get(DEFAULTS, (v) => {
          if (chrome.runtime.lastError) return resolve({ ...DEFAULTS });
          resolve({ ...DEFAULTS, ...v });
        });
      } catch (e) {
        resolve({ ...DEFAULTS });
      }
    });
  }

  function saveSettings() {
    try {
      chrome.storage.sync.set(state.settings);
    } catch (e) {
      /* storage is optional */
    }
  }
})();
