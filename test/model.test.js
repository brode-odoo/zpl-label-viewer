const fs = require('fs');
const vm = require('vm');

const ctx = { window: {}, console };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(require('path').join(__dirname, '..', 'zpl-model.js'), 'utf8'), ctx);
const ZM = ctx.window.__zplModel;

const SRC = `^XA
^FO100,50
^A0N,44,33^FDPACK0000001^FS
^FO100,100^BY3
^BCN,100,Y,N,N
^FDPACK0000001^FS
^XZ`;

let fails = 0;
const ok = (cond, name, extra) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
  if (!cond) { fails++; if (extra !== undefined) console.log('      ->', JSON.stringify(extra)); }
};

// --- parse
const m = ZM.parse(SRC, 0);
ok(m.elements.length === 2, 'finds 2 fields', m.elements.map(e => e.label));
const [txt, bc] = m.elements;
ok(txt.type === 'text' && txt.x === 100 && txt.y === 50, 'text field at 100,50', txt);
ok(txt.data === 'PACK0000001', 'text data', txt.data);
ok(txt.font.h === 44 && txt.font.w === 33, 'font 44/33', txt.font);
ok(bc.type === 'barcode' && bc.subtype === 'BC', 'barcode is Code 128', bc.subtype);
ok(bc.module === 3 && bc.bcHeight === 100 && bc.bcInterp === 'Y', 'BY3 / height 100 / interp Y', bc);
ok(bc.data === 'PACK0000001', 'barcode data', bc.data);
// estimate should land near the 470 dots the real render produced
ok(Math.abs(bc.box.w - 470) < 90, `barcode width estimate ~470 (got ${bc.box.w})`);

// --- move (surgical: nothing else may change)
let doc = ZM.replace(SRC, txt, ZM.setPosition(txt.raw, 160, 70));
ok(doc.includes('^FO160,70'), 'move rewrites ^FO', doc.split('\n')[1]);
ok(doc.includes('^A0N,44,33^FDPACK0000001^FS'), 'move leaves the rest of the field alone');
ok(doc.split('\n').length === SRC.split('\n').length, 'move preserves line structure');

// --- data + font + barcode edits
const m2 = ZM.parse(doc, 0);
doc = ZM.replace(doc, m2.elements[0], ZM.setData(m2.elements[0].raw, 'PACK0000042'));
ok(doc.includes('^FDPACK0000042^FS'), 'data edit');
const m3 = ZM.parse(doc, 0);
doc = ZM.replace(doc, m3.elements[0], ZM.setFont(m3.elements[0].raw, 1, 60));
ok(doc.includes('^A0N,60,33'), 'font height edit');

const m4 = ZM.parse(doc, 0);
let bcRaw = ZM.setBarcodeParam(m4.elements[1].raw, m4.elements[1].spec.height, 150);
bcRaw = ZM.setModule(bcRaw, 4);
ok(bcRaw.includes('^BCN,150,Y,N,N') && bcRaw.includes('^BY4'), 'barcode height + module', bcRaw);

// --- symbology swap adds the ^BQ data prefix
const qr = ZM.setBarcodeType(m4.elements[1].raw, 'BQ');
ok(qr.includes('^BQN,2,6') && qr.includes('^FDLA,PACK'), 'swap to QR prefixes data with LA,', qr.trim());
const back = ZM.setBarcodeType(ZM.parse(`^XA\n${qr}\n^XZ`, 0).elements[0].raw, 'BC');
ok(back.includes('^BCN') && !back.includes('LA,'), 'swap back to Code 128 strips prefix', back.trim());

// --- a field with commands the model does not model must survive a move
const EXOTIC = '^XA\n^FO50,50^FR^FB400,3,0,C^A0N,30,30^FDwrapped  text^FS\n^XZ';
const ex = ZM.parse(EXOTIC, 0).elements[0];
ok(ex.type === 'text', 'exotic field still classified as text');
const exMoved = ZM.setPosition(ex.raw, 80, 90);
ok(exMoved.includes('^FR') && exMoved.includes('^FB400,3,0,C') && exMoved.includes('wrapped  text'),
   'move keeps ^FR/^FB and double spaces', exMoved);

// --- insert + remove
const ins = ZM.insert(SRC, 0, 'qr', 300, 400);
ok(ins.zpl.includes('^FO300,400^BQN,2,6') && ins.zpl.trim().endsWith('^XZ'), 'insert before ^XZ', ins.zpl);
ok(ZM.parse(ins.zpl, 0).elements.length === 3, 'inserted field parses');
const insEl = ZM.parse(ins.zpl, 0).elements.find(e => e.x === 300);
ok(!ZM.remove(ins.zpl, insEl).includes('^BQ'), 'remove deletes the field');
ok(ZM.remove(ins.zpl, insEl).trim() === SRC.trim(), 'insert+remove round-trips to the original');

// --- formatter
const UGLY = '^XA^FO100,50^A0N,44,33^FDPACK 0001^FS^FO100,100^BY3^BCN,100,Y,N,N^FDPACK 0001^FS^PW812^XZ';
const pretty = ZM.format(UGLY);
console.log('\n--- formatted ---\n' + pretty + '-----------------');
ok(pretty.split('\n').filter(l => l.includes('^FO')).length === 2, 'one line per field');
ok(pretty.includes('  ^FO100,50^A0N,44,33^FDPACK 0001^FS'), 'field kept on one indented line');
ok(pretty.includes('^FDPACK 0001^FS'), 'spaces inside ^FD preserved');
ok(ZM.format(pretty) === pretty, 'formatter is idempotent');
ok(ZM.parse(pretty, 0).elements.length === 2, 'formatted output still parses');

// data with newlines must not be reflowed
const MULTI = '^XA^FO10,10^FDline one\nline two^FS^XZ';
ok(ZM.format(MULTI).includes('line one\nline two'), 'newlines inside ^FD preserved');

// --- multi-label documents
const TWO = SRC + '\n' + SRC.replace('PACK0000001', 'PACK0000002').replace(/PACK0000001/g, 'PACK0000002');
ok(ZM.labelBlocks(TWO).length === 2, 'two label blocks');
ok(ZM.parse(TWO, 1).elements[0].start > TWO.indexOf('^XZ'), 'index 1 parses the second label');
const ins2 = ZM.insert(TWO, 1, 'text', 5, 5);
ok(ins2.zpl.indexOf('^FO5,5') > ins2.zpl.indexOf('^XZ'), 'insert targets the selected label');

console.log(fails ? `\n${fails} FAILING` : '\nall green');
process.exit(fails ? 1 : 0);
