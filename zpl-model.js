/**
 * A deliberately shallow ZPL model.
 *
 * It parses far enough to know where each field sits and what kind of thing it
 * is, then edits by patching individual commands inside the field's original
 * text. Anything it does not recognise (^FB, ^FR, ^CI, comments, vendor
 * commands, whitespace and formatting) is carried through verbatim — the text
 * in the editor stays authoritative, the designer is just another way to type
 * into it.
 */

window.__zplModel = (() => {
  'use strict';

  const POS = ['FO', 'FT'];
  const DATA = ['FD', 'FV'];

  // Per-barcode parameter layout, so the inspector knows which slot is what.
  const BARCODES = {
    BC: { label: 'Code 128', params: 'N,100,Y,N,N', height: 1, interp: 2 },
    B3: { label: 'Code 39', params: 'N,N,100,Y,N', height: 2, interp: 3 },
    BE: { label: 'EAN-13', params: 'N,100,Y,N', height: 1, interp: 2 },
    BU: { label: 'UPC-A', params: 'N,100,Y,N', height: 1, interp: 2 },
    B8: { label: 'EAN-8', params: 'N,100,Y,N', height: 1, interp: 2 },
    B2: { label: 'Interleaved 2 of 5', params: 'N,100,Y,N,N', height: 1, interp: 2 },
    BQ: { label: 'QR Code', params: 'N,2,6', height: -1, interp: -1, magnification: 2 },
    BX: { label: 'Data Matrix', params: 'N,6,200', height: -1, interp: -1, magnification: 1 },
    B7: { label: 'PDF417', params: 'N,3,5,,,N', height: -1, interp: -1 }
  };

  const FONT_RE = /^A[0-9A-Z@]$/;
  const BARCODE_RE = /^B[0-9A-Z]$/;
  const GRAPHIC_RE = /^G[BCDES]$/;

  /* ---------------------------------------------------------------- *
   * tokenizer
   * ---------------------------------------------------------------- */

  function tokenize(text) {
    const tokens = [];
    let i = 0;
    while (i < text.length) {
      const c = text[i];
      if (c !== '^' && c !== '~') {
        i++;
        continue;
      }
      const name = text.substr(i + 1, 2).toUpperCase();
      const paramsStart = i + 3;
      let end;
      if (DATA.includes(name)) {
        // Field data runs to ^FS, not to the next caret.
        const fs = text.toUpperCase().indexOf('^FS', paramsStart);
        end = fs === -1 ? text.length : fs;
      } else {
        let j = paramsStart;
        while (j < text.length && text[j] !== '^' && text[j] !== '~') j++;
        end = j;
      }
      tokens.push({ name, start: i, paramsStart, end, params: text.slice(paramsStart, end) });
      i = Math.max(end, i + 1);
    }
    return tokens;
  }

  /* ---------------------------------------------------------------- *
   * parsing
   * ---------------------------------------------------------------- */

  function labelBlocks(zpl) {
    const re = /\^XA[\s\S]*?\^XZ/gi;
    const out = [];
    let m;
    while ((m = re.exec(zpl))) out.push({ start: m.index, end: m.index + m[0].length });
    return out;
  }

  function parse(zpl, labelIndex) {
    const blocks = labelBlocks(zpl);
    const block = blocks.length
      ? blocks[Math.min(Math.max(labelIndex || 0, 0), blocks.length - 1)]
      : { start: 0, end: zpl.length };
    const text = zpl.slice(block.start, block.end);
    return { block, blocks, elements: parseFields(text, block.start) };
  }

  function parseFields(text, offset) {
    const tokens = tokenize(text);
    const fields = [];
    let cur = null;

    const close = (endIdx) => {
      cur.end = endIdx;
      fields.push(describe(text.slice(cur.start, cur.end), cur.start + offset, cur.end + offset, cur.tokens));
      cur = null;
    };

    for (const t of tokens) {
      if (POS.includes(t.name)) {
        if (cur) close(t.start); // previous field never hit ^FS
        cur = { start: t.start, tokens: [t] };
      } else if (cur) {
        cur.tokens.push(t);
        if (t.name === 'FS') close(t.end);
      }
    }
    if (cur) close(text.length);
    return fields;
  }

  function describe(raw, start, end, tokens) {
    const rel = tokens.map((t) => ({ ...t, start: t.start - (tokens[0].start || 0) }));
    const pos = tokens[0];
    const posParams = split(pos.params);
    const fontTok = tokens.find((t) => FONT_RE.test(t.name));
    const bcTok = tokens.find((t) => BARCODE_RE.test(t.name) && t.name !== 'BY');
    const byTok = tokens.find((t) => t.name === 'BY');
    const gbTok = tokens.find((t) => GRAPHIC_RE.test(t.name));
    const dataTok = tokens.find((t) => DATA.includes(t.name));

    const el = {
      start,
      end,
      raw,
      tokens: rel,
      posCmd: pos.name,
      x: int(posParams[0], 0),
      y: int(posParams[1], 0),
      data: dataTok ? dataTok.params : '',
      hasData: !!dataTok
    };

    if (bcTok && BARCODES[bcTok.name]) {
      const spec = BARCODES[bcTok.name];
      const p = split(bcTok.params);
      el.type = 'barcode';
      el.subtype = bcTok.name;
      el.spec = spec;
      el.orient = (p[0] || 'N').toUpperCase();
      el.bcHeight = spec.height >= 0 ? int(p[spec.height], 100) : 0;
      el.bcInterp = spec.interp >= 0 ? (p[spec.interp] || 'N').toUpperCase() : 'N';
      el.magnification = spec.magnification >= 0 ? int(p[spec.magnification], 2) : 0;
      el.module = byTok ? int(split(byTok.params)[0], 2) : 2;
    } else if (gbTok && gbTok.name === 'GB') {
      const p = split(gbTok.params);
      el.type = 'box';
      el.gb = {
        w: int(p[0], 1),
        h: int(p[1], 1),
        t: int(p[2], 1),
        color: (p[3] || 'B').toUpperCase(),
        round: int(p[4], 0)
      };
    } else if (el.hasData) {
      el.type = 'text';
      const p = fontTok ? split(fontTok.params) : [];
      el.font = {
        name: fontTok ? fontTok.name[1] : '',
        orient: (p[0] || 'N').toUpperCase(),
        h: int(p[1], 0),
        w: int(p[2], 0),
        explicit: !!fontTok
      };
      el.orient = el.font.orient;
    } else {
      el.type = 'other';
    }

    el.box = estimate(el);
    el.label = describeLabel(el);
    return el;
  }

  function describeLabel(el) {
    if (el.type === 'text') return `Text · ${trunc(el.data)}`;
    if (el.type === 'barcode') return `${el.spec.label} · ${trunc(el.data)}`;
    if (el.type === 'box') return el.gb.h <= 1 || el.gb.w <= 1 ? 'Line' : 'Box';
    const cmd = el.tokens.find((t) => !POS.includes(t.name) && t.name !== 'FS');
    return cmd ? `^${cmd.name}` : 'Field';
  }

  /**
   * Rough outline size in dots. Only used to give each field a grab handle over
   * the real rendered image, so being a little off is harmless.
   */
  function estimate(el) {
    let w = 60;
    let h = 40;

    if (el.type === 'box') {
      w = el.gb.w + el.gb.t;
      h = el.gb.h + el.gb.t;
    } else if (el.type === 'text') {
      h = el.font.h || 30;
      const charW = (el.font.w || h) * 0.58;
      w = Math.max(16, (el.data || '').length * charW);
    } else if (el.type === 'barcode') {
      const n = Math.max(1, (el.data || '').replace(/^[A-Z]{2},/i, '').length);
      const m = el.module || 2;
      if (el.subtype === 'BQ') {
        w = h = (el.magnification || 2) * 29 + 12;
      } else if (el.subtype === 'BX') {
        w = h = (el.magnification || 6) * 12 + 12;
      } else if (el.subtype === 'B7') {
        w = n * m * 9;
        h = 80;
      } else {
        // Code 128 is 11 modules per character plus start/stop/check + quiet zone.
        const perChar = el.subtype === 'B3' ? 16 : 11;
        w = (perChar * (n + 2) + 13) * m;
        h = (el.bcHeight || 100) + (el.bcInterp === 'Y' ? Math.max(20, m * 10) : 0);
      }
    }

    if (el.orient === 'R' || el.orient === 'B') [w, h] = [h, w];
    return { w: Math.round(w), h: Math.round(h) };
  }

  /* ---------------------------------------------------------------- *
   * patching — every editor below takes a field's raw text, returns new text
   * ---------------------------------------------------------------- */

  function tokenOf(raw, pred) {
    return tokenize(raw).find(pred);
  }

  function setTokenParams(raw, tok, params) {
    // A command's parameters run to the next caret, so they swallow the
    // whitespace that follows — put it back, or rewriting ^FO100,50\n would
    // join the next line onto it. ^FD is exempt: there the trailing spaces are
    // data being replaced.
    const trail = DATA.includes(tok.name) ? '' : /\s*$/.exec(tok.params)[0];
    return raw.slice(0, tok.paramsStart) + params + trail + raw.slice(tok.end);
  }

  function setParamAt(raw, tok, index, value) {
    const p = split(tok.params);
    while (p.length <= index) p.push('');
    p[index] = String(value);
    return setTokenParams(raw, tok, p.join(','));
  }

  function setPosition(raw, x, y) {
    const tok = tokenOf(raw, (t) => POS.includes(t.name));
    if (!tok) return raw;
    const p = split(tok.params);
    p[0] = String(Math.max(0, Math.round(x)));
    p[1] = String(Math.max(0, Math.round(y)));
    return setTokenParams(raw, tok, p.join(','));
  }

  function setData(raw, value) {
    const tok = tokenOf(raw, (t) => DATA.includes(t.name));
    const safe = String(value).replace(/[\^~]/g, ' '); // carets would end the field
    if (!tok) return raw;
    return setTokenParams(raw, tok, safe);
  }

  /** Set a font parameter, adding a ^A0 command if the field inherits ^CF. */
  function setFont(raw, index, value) {
    let tok = tokenOf(raw, (t) => FONT_RE.test(t.name));
    if (!tok) {
      const pos = tokenOf(raw, (t) => POS.includes(t.name));
      if (!pos) return raw;
      raw = raw.slice(0, pos.end) + '^A0N,30,30' + raw.slice(pos.end);
      tok = tokenOf(raw, (t) => FONT_RE.test(t.name));
    }
    return setParamAt(raw, tok, index, value);
  }

  function setBarcodeParam(raw, index, value) {
    const tok = tokenOf(raw, (t) => BARCODE_RE.test(t.name) && t.name !== 'BY' && BARCODES[t.name]);
    if (!tok || index < 0) return raw;
    return setParamAt(raw, tok, index, value);
  }

  /** Module width lives in ^BY, which the field may not carry yet. */
  function setModule(raw, value) {
    let tok = tokenOf(raw, (t) => t.name === 'BY');
    if (!tok) {
      const pos = tokenOf(raw, (t) => POS.includes(t.name));
      if (!pos) return raw;
      raw = raw.slice(0, pos.end) + `^BY${Math.max(1, Math.round(value))}` + raw.slice(pos.end);
      return raw;
    }
    return setParamAt(raw, tok, 0, Math.max(1, Math.round(value)));
  }

  function setGb(raw, index, value) {
    const tok = tokenOf(raw, (t) => t.name === 'GB');
    if (!tok) return raw;
    return setParamAt(raw, tok, index, value);
  }

  /** Swap one barcode command for another, carrying the data across. */
  function setBarcodeType(raw, newType) {
    const spec = BARCODES[newType];
    if (!spec) return raw;
    const tok = tokenOf(raw, (t) => BARCODE_RE.test(t.name) && t.name !== 'BY' && BARCODES[t.name]);
    if (!tok) return raw;

    const wasQr = tok.name === 'BQ' || tok.name === 'BX';
    const isQr = newType === 'BQ' || newType === 'BX';
    let out = raw.slice(0, tok.start) + `^${newType}${spec.params}` + raw.slice(tok.end);

    // ^BQ expects a mode prefix on its data ("LA,"); the linear symbologies do not.
    const dataTok = tokenOf(out, (t) => DATA.includes(t.name));
    if (dataTok) {
      let d = dataTok.params;
      if (isQr && !wasQr && !/^[A-Z]{2},/i.test(d)) d = `LA,${d}`;
      if (!isQr && wasQr) d = d.replace(/^[A-Z]{2},/i, '');
      out = setTokenParams(out, dataTok, d);
    }
    return out;
  }

  /* ---------------------------------------------------------------- *
   * document-level operations
   * ---------------------------------------------------------------- */

  function replace(zpl, el, raw) {
    return zpl.slice(0, el.start) + raw + zpl.slice(el.end);
  }

  function remove(zpl, el) {
    let { start, end } = el;
    // Take the field's own line with it when it has one.
    while (start > 0 && (zpl[start - 1] === ' ' || zpl[start - 1] === '\t')) start--;
    if (zpl[start - 1] === '\n' && (zpl[end] === '\n' || end >= zpl.length)) start--;
    return zpl.slice(0, start) + zpl.slice(end);
  }

  const SNIPPETS = {
    text: (x, y) => `^FO${x},${y}^A0N,40,40^FDText^FS`,
    barcode: (x, y) => `^FO${x},${y}^BY3^BCN,100,Y,N,N^FD12345678^FS`,
    qr: (x, y) => `^FO${x},${y}^BQN,2,6^FDLA,12345678^FS`,
    box: (x, y) => `^FO${x},${y}^GB200,120,3,B,0^FS`,
    line: (x, y) => `^FO${x},${y}^GB300,0,3,B,0^FS`
  };

  /** Returns { zpl, offset } — offset is where the new field landed. */
  function insert(zpl, labelIndex, kind, x, y) {
    const make = SNIPPETS[kind];
    if (!make) return { zpl, offset: -1 };
    const snippet = make(Math.max(0, Math.round(x)), Math.max(0, Math.round(y)));

    if (!zpl.trim()) return { zpl: `^XA\n${snippet}\n^XZ`, offset: 4 };

    const { block } = parse(zpl, labelIndex);
    const close = zpl.toUpperCase().lastIndexOf('^XZ', block.end);
    if (close === -1) return { zpl: `${zpl}\n${snippet}`, offset: zpl.length + 1 };

    const lead = zpl[close - 1] === '\n' ? '' : '\n';
    const offset = close + lead.length;
    return { zpl: zpl.slice(0, close) + lead + snippet + '\n' + zpl.slice(close), offset };
  }

  /* ---------------------------------------------------------------- *
   * formatting
   * ---------------------------------------------------------------- */

  /**
   * One field per line, indented inside ^XA…^XZ.
   *
   * Rebuilt from tokens rather than by regex, so spaces and newlines that are
   * part of ^FD data survive untouched — reflowing those would change what the
   * label prints.
   */
  function format(zpl) {
    const tokens = tokenize(zpl);
    if (!tokens.length) return zpl;

    const lines = [];
    let line = '';
    let depth = 0;
    let inField = false;
    let prevEnd = 0;

    const flush = () => {
      if (line.trim()) lines.push('  '.repeat(depth) + line.trim());
      line = '';
    };

    for (const t of tokens) {
      // Keep anything that is not a command (rare, but never drop it).
      const gap = zpl.slice(prevEnd, t.start).trim();
      if (gap) line += gap;
      prevEnd = t.end;

      // Trailing whitespace belongs to the layout, not the parameters — drop it
      // so a field collapses onto one line. ^FD keeps its data byte for byte.
      const params = DATA.includes(t.name) ? t.params : t.params.replace(/\s+$/, '');
      const text = (t.start < zpl.length ? zpl[t.start] : '^') + t.name + params;

      if (t.name === 'XA') {
        flush();
        lines.push('^XA');
        depth = 1;
        inField = false;
        continue;
      }
      if (t.name === 'XZ') {
        flush();
        depth = 0;
        lines.push('^XZ');
        inField = false;
        continue;
      }
      if (POS.includes(t.name)) {
        flush();
        inField = true;
        line = text;
        continue;
      }
      if (t.name === 'FS') {
        line += text;
        flush();
        inField = false;
        continue;
      }
      if (inField) {
        line += text;
      } else {
        flush();
        line = text;
        flush();
      }
    }
    flush();

    const tail = zpl.slice(prevEnd).trim();
    if (tail) lines.push(tail);

    // Blank line between labels keeps multi-label documents readable.
    return lines.join('\n').replace(/\n\^XA/g, '\n\n^XA').replace(/^\n+/, '') + '\n';
  }

  /* ---------------------------------------------------------------- *
   * helpers
   * ---------------------------------------------------------------- */

  function split(s) {
    return String(s || '').split(',');
  }

  function int(v, fallback) {
    const n = parseInt(String(v).trim(), 10);
    return Number.isFinite(n) ? n : fallback;
  }

  function trunc(s) {
    const t = String(s || '').replace(/^[A-Z]{2},/i, '').trim();
    return t.length > 18 ? `${t.slice(0, 18)}…` : t || '(empty)';
  }

  return {
    BARCODES,
    tokenize,
    labelBlocks,
    parse,
    format,
    setPosition,
    setData,
    setFont,
    setBarcodeParam,
    setBarcodeType,
    setModule,
    setGb,
    replace,
    remove,
    insert
  };
})();
