/**
 * The visual editing layer: draggable outlines over the rendered label, a
 * palette of blocks to drop onto it, and a property inspector.
 *
 * It owns no ZPL of its own — every gesture is translated into an edit of the
 * text in the editor pane via window.__zplModel, and the label is then
 * re-rendered from that text.
 */

window.__zplDesigner = function createDesigner(o) {
  'use strict';

  const ZM = window.__zplModel;

  const PALETTE = [
    { kind: 'text', label: 'Text', glyph: 'Aa' },
    { kind: 'barcode', label: 'Barcode', glyph: '||||' },
    { kind: 'qr', label: 'QR code', glyph: '▚' },
    { kind: 'box', label: 'Box', glyph: '▭' },
    { kind: 'line', label: 'Line', glyph: '──' }
  ];

  const state = {
    active: true,
    sel: -1,
    snap: 1,
    model: { elements: [] }
  };

  buildPalette();

  /* ------------------------------------------------------------------ *
   * model sync
   * ------------------------------------------------------------------ */

  function parse() {
    state.model = ZM.parse(o.getZpl(), o.getLabelIndex());
    if (state.sel >= state.model.elements.length) state.sel = state.model.elements.length - 1;
    return state.model;
  }

  function current() {
    return state.sel >= 0 ? state.model.elements[state.sel] : null;
  }

  function refresh() {
    parse();
    drawOverlay();
    drawInspector();
  }

  /** Apply new raw text for a field, redraw instantly, re-render lazily. */
  function commit(el, raw, { rebuildInspector = false } = {}) {
    if (raw === el.raw) return;
    o.setZpl(ZM.replace(o.getZpl(), el, raw));
    parse();
    drawOverlay();
    if (rebuildInspector) drawInspector();
    o.requestRender();
  }

  /* ------------------------------------------------------------------ *
   * palette
   * ------------------------------------------------------------------ */

  function buildPalette() {
    o.palette.innerHTML =
      `<div class="section-title">Drag onto the label</div><div class="palette">` +
      PALETTE.map(
        (p) =>
          `<button class="block" data-kind="${p.kind}" title="Drag onto the label, or click to drop it top-left">
             <span class="glyph">${p.glyph}</span><span>${p.label}</span>
           </button>`
      ).join('') +
      `</div>`;

    o.palette.querySelectorAll('.block').forEach((btn) => {
      btn.addEventListener('pointerdown', (e) => startPaletteDrag(e, btn));
    });
  }

  function startPaletteDrag(e, btn) {
    e.preventDefault();
    const kind = btn.dataset.kind;
    const ghost = document.createElement('div');
    ghost.className = 'ghost';
    ghost.textContent = btn.textContent.trim();
    o.wrap.appendChild(ghost);
    const place = (ev) => {
      ghost.style.left = `${ev.clientX + 12}px`;
      ghost.style.top = `${ev.clientY + 12}px`;
    };
    place(e);
    btn.setPointerCapture(e.pointerId);

    const move = (ev) => place(ev);
    const up = (ev) => {
      btn.releasePointerCapture(ev.pointerId);
      btn.removeEventListener('pointermove', move);
      btn.removeEventListener('pointerup', up);
      ghost.remove();
      const pt = pointToDots(ev.clientX, ev.clientY);
      addBlock(kind, pt ? pt.x : 40, pt ? pt.y : 40);
    };
    btn.addEventListener('pointermove', move);
    btn.addEventListener('pointerup', up);
  }

  function addBlock(kind, x, y) {
    const res = ZM.insert(o.getZpl(), o.getLabelIndex(), kind, snap(x), snap(y));
    if (res.offset < 0) return;
    o.setZpl(res.zpl);
    parse();
    // Select whatever landed at the insertion point.
    const idx = state.model.elements.findIndex((el) => el.start >= res.offset);
    state.sel = idx === -1 ? state.model.elements.length - 1 : idx;
    drawOverlay();
    drawInspector();
    o.requestRender();
  }

  /* ------------------------------------------------------------------ *
   * overlay
   * ------------------------------------------------------------------ */

  function view() {
    const v = o.getView();
    if (!v || !v.img || !v.overlay || !v.img.naturalWidth) return null;
    v.scale = v.img.clientWidth / v.img.naturalWidth;
    return v;
  }

  function pointToDots(clientX, clientY) {
    const v = view();
    if (!v) return null;
    const r = v.img.getBoundingClientRect();
    if (clientX < r.left || clientX > r.right || clientY < r.top || clientY > r.bottom) return null;
    return {
      x: Math.round((clientX - r.left) / v.scale),
      y: Math.round((clientY - r.top) / v.scale)
    };
  }

  function rectOf(el, v) {
    const top = el.posCmd === 'FT' ? el.y - el.box.h : el.y;
    return {
      left: el.x * v.scale,
      top: top * v.scale,
      width: Math.max(10, el.box.w * v.scale),
      height: Math.max(10, el.box.h * v.scale)
    };
  }

  function drawOverlay() {
    const v = view();
    if (!v) return;
    v.overlay.innerHTML = '';
    v.overlay.style.display = state.active ? 'block' : 'none';
    if (!state.active) return;

    state.model.elements.forEach((el, i) => {
      const box = document.createElement('div');
      box.className = `el el-${el.type}${i === state.sel ? ' sel' : ''}`;
      const r = rectOf(el, v);
      box.style.cssText = `left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px`;
      box.innerHTML = `<span class="tag">${escapeHtml(el.label)}</span>`;

      if (el.type === 'box') {
        const grip = document.createElement('span');
        grip.className = 'grip';
        grip.addEventListener('pointerdown', (e) => startResize(e, i));
        box.appendChild(grip);
      }

      box.addEventListener('pointerdown', (e) => startMove(e, i));
      v.overlay.appendChild(box);
    });
  }

  function startMove(e, i) {
    e.preventDefault();
    e.stopPropagation();
    select(i);
    const v = view();
    const el = state.model.elements[i];
    if (!v || !el) return;

    const box = v.overlay.children[i];
    const startX = e.clientX;
    const startY = e.clientY;
    const origX = el.x;
    const origY = el.y;
    let next = { x: origX, y: origY };
    box.setPointerCapture(e.pointerId);
    box.classList.add('dragging');

    const move = (ev) => {
      next = {
        x: Math.max(0, snap(origX + (ev.clientX - startX) / v.scale)),
        y: Math.max(0, snap(origY + (ev.clientY - startY) / v.scale))
      };
      const r = rectOf({ ...el, x: next.x, y: next.y }, v);
      box.style.left = `${r.left}px`;
      box.style.top = `${r.top}px`;
      hint(`x ${next.x} · y ${next.y} dots`);
    };
    const up = (ev) => {
      box.releasePointerCapture(ev.pointerId);
      box.removeEventListener('pointermove', move);
      box.removeEventListener('pointerup', up);
      box.classList.remove('dragging');
      hint('');
      if (next.x !== origX || next.y !== origY) {
        commit(el, ZM.setPosition(el.raw, next.x, next.y), { rebuildInspector: true });
      }
    };
    box.addEventListener('pointermove', move);
    box.addEventListener('pointerup', up);
  }

  function startResize(e, i) {
    e.preventDefault();
    e.stopPropagation();
    select(i);
    const v = view();
    const el = state.model.elements[i];
    if (!v || !el || el.type !== 'box') return;

    const box = v.overlay.children[i];
    const startX = e.clientX;
    const startY = e.clientY;
    const orig = { w: el.gb.w, h: el.gb.h };
    let next = { ...orig };
    e.target.setPointerCapture(e.pointerId);

    const move = (ev) => {
      next = {
        w: Math.max(1, snap(orig.w + (ev.clientX - startX) / v.scale)),
        h: Math.max(0, snap(orig.h + (ev.clientY - startY) / v.scale))
      };
      box.style.width = `${Math.max(10, (next.w + el.gb.t) * v.scale)}px`;
      box.style.height = `${Math.max(10, (next.h + el.gb.t) * v.scale)}px`;
      hint(`${next.w} × ${next.h} dots`);
    };
    const up = (ev) => {
      e.target.releasePointerCapture(ev.pointerId);
      e.target.removeEventListener('pointermove', move);
      e.target.removeEventListener('pointerup', up);
      hint('');
      if (next.w !== orig.w || next.h !== orig.h) {
        let raw = ZM.setGb(el.raw, 0, next.w);
        raw = ZM.setGb(raw, 1, next.h);
        commit(el, raw, { rebuildInspector: true });
      }
    };
    e.target.addEventListener('pointermove', move);
    e.target.addEventListener('pointerup', up);
  }

  function select(i) {
    if (state.sel === i) return;
    state.sel = i;
    drawOverlay();
    drawInspector();
  }

  /* ------------------------------------------------------------------ *
   * inspector
   * ------------------------------------------------------------------ */

  function drawInspector() {
    const el = current();
    if (!el) {
      o.inspector.innerHTML =
        `<div class="section-title">Properties</div>
         <div class="empty">Click a field on the label to edit it, or drag a block from above.
         Outlines are estimates — the label underneath is the real render.</div>`;
      return;
    }

    const rows = [
      `<div class="section-title">${escapeHtml(el.label)}
         <span class="badge">${el.posCmd === 'FT' ? '^FT' : '^FO'}</span></div>`,
      grid([
        num('X', 'x', el.x, 'dots'),
        num('Y', 'y', el.y, 'dots')
      ])
    ];

    if (el.type === 'text') {
      rows.push(
        text('Text', 'data', el.data),
        grid([
          num('Height', 'fontH', el.font.h || 30, 'dots'),
          num('Width', 'fontW', el.font.w || el.font.h || 30, 'dots')
        ]),
        select_('Rotation', 'orient', el.font.orient, [
          ['N', 'Normal'],
          ['R', '90° right'],
          ['I', '180°'],
          ['B', '270°']
        ]),
        el.font.explicit ? '' : `<div class="note">Inherits the label's ^CF font — editing size adds an ^A0.</div>`
      );
    } else if (el.type === 'barcode') {
      const opts = Object.keys(ZM.BARCODES).map((k) => [k, ZM.BARCODES[k].label]);
      rows.push(
        text('Data', 'data', el.data),
        select_('Symbology', 'bcType', el.subtype, opts),
        grid([
          el.spec.height >= 0 ? num('Height', 'bcHeight', el.bcHeight, 'dots') : '',
          el.spec.magnification >= 0
            ? num('Magnify', 'bcMag', el.magnification, '×')
            : num('Module', 'bcModule', el.module, 'dots')
        ]),
        el.spec.interp >= 0
          ? select_('Human-readable text', 'bcInterp', el.bcInterp, [
              ['Y', 'Show below'],
              ['N', 'Hide']
            ])
          : '',
        select_('Rotation', 'orient', el.orient, [
          ['N', 'Normal'],
          ['R', '90° right'],
          ['I', '180°'],
          ['B', '270°']
        ])
      );
    } else if (el.type === 'box') {
      rows.push(
        grid([
          num('Width', 'gbW', el.gb.w, 'dots'),
          num('Height', 'gbH', el.gb.h, 'dots')
        ]),
        grid([
          num('Thickness', 'gbT', el.gb.t, 'dots'),
          num('Corner', 'gbRound', el.gb.round, '0–8')
        ]),
        select_('Colour', 'gbColor', el.gb.color, [
          ['B', 'Black'],
          ['W', 'White']
        ])
      );
    } else {
      rows.push(
        `<div class="note">No visual editor for this command — drag it to reposition, or edit it in the ZPL tab.</div>`,
        `<pre class="rawview">${escapeHtml(el.raw.trim())}</pre>`
      );
    }

    rows.push(
      `<div class="row-btns">
         <button data-act="duplicate">Duplicate</button>
         <button data-act="delete" class="danger">Delete</button>
       </div>`
    );

    o.inspector.innerHTML = rows.filter(Boolean).join('');

    o.inspector.querySelectorAll('[data-field]').forEach((input) => {
      const ev = input.tagName === 'SELECT' ? 'change' : 'input';
      input.addEventListener(ev, () => applyField(input.dataset.field, input.value));
    });
    o.inspector.querySelectorAll('[data-act]').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (btn.dataset.act === 'delete') removeSelected();
        else duplicateSelected();
      });
    });
  }

  function applyField(field, value) {
    const el = current();
    if (!el) return;
    const n = parseInt(value, 10);
    const isNum = Number.isFinite(n);
    let raw = el.raw;
    let rebuild = false;

    switch (field) {
      case 'x':
        if (isNum) raw = ZM.setPosition(raw, n, el.y);
        break;
      case 'y':
        if (isNum) raw = ZM.setPosition(raw, el.x, n);
        break;
      case 'data':
        raw = ZM.setData(raw, value);
        break;
      case 'fontH':
        if (isNum) raw = ZM.setFont(raw, 1, n);
        break;
      case 'fontW':
        if (isNum) raw = ZM.setFont(raw, 2, n);
        break;
      case 'orient':
        raw = el.type === 'text' ? ZM.setFont(raw, 0, value) : ZM.setBarcodeParam(raw, 0, value);
        break;
      case 'bcType':
        raw = ZM.setBarcodeType(raw, value);
        rebuild = true;
        break;
      case 'bcHeight':
        if (isNum) raw = ZM.setBarcodeParam(raw, el.spec.height, n);
        break;
      case 'bcInterp':
        raw = ZM.setBarcodeParam(raw, el.spec.interp, value);
        break;
      case 'bcMag':
        if (isNum) raw = ZM.setBarcodeParam(raw, el.spec.magnification, n);
        break;
      case 'bcModule':
        if (isNum) raw = ZM.setModule(raw, n);
        break;
      case 'gbW':
        if (isNum) raw = ZM.setGb(raw, 0, n);
        break;
      case 'gbH':
        if (isNum) raw = ZM.setGb(raw, 1, n);
        break;
      case 'gbT':
        if (isNum) raw = ZM.setGb(raw, 2, n);
        break;
      case 'gbColor':
        raw = ZM.setGb(raw, 3, value);
        break;
      case 'gbRound':
        if (isNum) raw = ZM.setGb(raw, 4, Math.min(8, Math.max(0, n)));
        break;
      default:
        return;
    }
    commit(el, raw, { rebuildInspector: rebuild });
  }

  function removeSelected() {
    const el = current();
    if (!el) return;
    o.setZpl(ZM.remove(o.getZpl(), el));
    state.sel = -1;
    refresh();
    o.requestRender();
  }

  function duplicateSelected() {
    const el = current();
    if (!el) return;
    const copy = ZM.setPosition(el.raw, el.x + 20, el.y + 20);
    const doc = o.getZpl();
    o.setZpl(doc.slice(0, el.end) + '\n' + copy + doc.slice(el.end));
    parse();
    state.sel = Math.min(state.sel + 1, state.model.elements.length - 1);
    drawOverlay();
    drawInspector();
    o.requestRender();
  }

  /* ------------------------------------------------------------------ *
   * keyboard nudging
   * ------------------------------------------------------------------ */

  function handleKey(e) {
    if (!state.active) return false;
    const el = current();
    if (!el) return false;
    const tag = e.composedPath()[0] && e.composedPath()[0].tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return false;

    if (e.key === 'Delete' || e.key === 'Backspace') {
      removeSelected();
      return true;
    }
    const step = (e.shiftKey ? 10 : 1) * Math.max(1, state.snap);
    const moves = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, -step],
      ArrowDown: [0, step]
    };
    const d = moves[e.key];
    if (!d) return false;
    commit(el, ZM.setPosition(el.raw, Math.max(0, el.x + d[0]), Math.max(0, el.y + d[1])), {
      rebuildInspector: true
    });
    return true;
  }

  /* ------------------------------------------------------------------ *
   * small helpers
   * ------------------------------------------------------------------ */

  function snap(v) {
    const s = Math.max(1, state.snap);
    return Math.round(Math.round(v) / s) * s;
  }

  function hint(text) {
    if (o.hint) o.hint.textContent = text;
  }

  function grid(cells) {
    return `<div class="grid2">${cells.filter(Boolean).join('')}</div>`;
  }

  function num(label, field, value, unit) {
    return `<label class="fld"><span>${label}${unit ? ` <em>${unit}</em>` : ''}</span>
      <input type="number" data-field="${field}" value="${value}"></label>`;
  }

  function text(label, field, value) {
    return `<label class="fld"><span>${label}</span>
      <input type="text" data-field="${field}" value="${escapeAttr(value)}"></label>`;
  }

  function select_(label, field, value, options) {
    const opts = options
      .map(([v, t]) => `<option value="${v}"${v === value ? ' selected' : ''}>${t}</option>`)
      .join('');
    return `<label class="fld"><span>${label}</span>
      <select data-field="${field}">${opts}</select></label>`;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  }

  function escapeAttr(s) {
    return escapeHtml(s).replace(/'/g, '&#39;');
  }

  return {
    refresh,
    drawOverlay,
    handleKey,
    setActive(v) {
      state.active = v;
      drawOverlay();
    },
    setSnap(v) {
      state.snap = Math.max(1, parseInt(v, 10) || 1);
    },
    clearSelection() {
      state.sel = -1;
      drawOverlay();
      drawInspector();
    }
  };
};
