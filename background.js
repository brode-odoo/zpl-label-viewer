/**
 * Service worker: does the Labelary calls.
 *
 * Rendering has to happen here rather than in the content script: a content
 * script's fetch is subject to the host page's CORS rules, while the worker
 * fetches under the extension's own host permission and can also read the
 * X-Total-Count / X-Warnings response headers.
 */

const API = 'https://api.labelary.com/v1/printers';
const VALID_DPMM = [6, 8, 12, 24];

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === 'render') {
    renderLabel(msg.options)
      .then(sendResponse)
      .catch((err) => sendResponse({ ok: false, error: String((err && err.message) || err) }));
    return true; // keep the message channel open for the async response
  }
  return false;
});

chrome.action.onClicked.addListener((tab) => toggleViewer(tab));

chrome.commands.onCommand.addListener((command, tab) => {
  if (command === 'toggle-viewer') toggleViewer(tab);
});

async function toggleViewer(tab) {
  if (!tab || !tab.id) return;
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'toggle' });
  } catch (e) {
    // No content script yet (e.g. the extension was just installed/reloaded).
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['zpl-model.js', 'designer.js', 'content.js']
      });
      await chrome.tabs.sendMessage(tab.id, { type: 'toggle' });
    } catch (e2) {
      console.warn('ZPL Label Viewer cannot run on this page:', e2);
    }
  }
}

async function renderLabel(options) {
  const o = options || {};
  const dpmm = VALID_DPMM.includes(Number(o.dpmm)) ? Number(o.dpmm) : 8;
  const width = clamp(Number(o.width) || 4, 0.1, 15);
  const height = clamp(Number(o.height) || 6, 0.1, 15);
  const index = Math.max(0, parseInt(o.index, 10) || 0);
  const rotation = [0, 90, 180, 270].includes(Number(o.rotation)) ? Number(o.rotation) : 0;
  const pdf = o.format === 'pdf';
  const mime = pdf ? 'application/pdf' : 'image/png';
  const zpl = String(o.zpl || '');

  if (!zpl.trim()) throw new Error('Nothing to render — the ZPL is empty.');

  const url = `${API}/${dpmm}dpmm/labels/${trimNum(width)}x${trimNum(height)}/${index}/`;
  const res = await postWithRetry(url, {
    method: 'POST',
    headers: {
      // Labelary rejects text/plain with 415; urlencoded is what it expects
      // for a raw (non-multipart) ZPL body.
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: mime,
      'X-Rotation': String(rotation),
      'X-Linter': 'ON'
    },
    body: zpl
  });

  const total = parseInt(res.headers.get('X-Total-Count') || '1', 10) || 1;
  const warnings = res.headers.get('X-Warnings') || '';

  if (!res.ok) {
    const text = (await res.text()).trim();
    throw new Error(`Labelary ${res.status}: ${text.slice(0, 400) || res.statusText}`);
  }

  const buf = await res.arrayBuffer();
  return { ok: true, total, warnings, mime, dataUrl: `data:${mime};base64,${toBase64(buf)}` };
}

/** Labelary throttles at 5 requests/second and answers 429 with Retry-After. */
async function postWithRetry(url, init) {
  let res = await fetch(url, init);
  if (res.status === 429) {
    const wait = Math.min(5000, (parseFloat(res.headers.get('Retry-After')) || 1) * 1000);
    await new Promise((r) => setTimeout(r, wait));
    res = await fetch(url, init);
  }
  return res;
}

function toBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

function trimNum(n) {
  return String(Math.round(n * 100) / 100);
}
