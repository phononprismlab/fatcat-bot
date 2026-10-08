'use strict';
const zlib = require('node:zlib');
const path = require('node:path');
const { loadFont } = require('./ttf');
const { subsetFont } = require('./ttf-subset');

// 零依赖 PDF 生成器：只做「中文文本排版」这一件事。
// 关键点：把用到的字形子集化后以 Type0/CIDFontType2 + Identity-H 嵌入，
// 因此任何 PDF 阅读器（含浏览器内置）都能正确显示中文，不依赖系统字体。

const PAGE_A4 = { width: 595.28, height: 841.89 };

const STYLES = {
  title: { size: 17, color: [0.09, 0.11, 0.15], gapBefore: 0, bold: true },
  label: { size: 11, color: [0.13, 0.15, 0.2], gapBefore: 10, bold: true },
  meta: { size: 9, color: [0.45, 0.48, 0.55], gapBefore: 2 },
  speaker: { size: 9.5, color: [0.15, 0.42, 0.6], gapBefore: 10, bold: true },
  para: { size: 10.5, color: [0.12, 0.13, 0.16], gapBefore: 3 },
  quote: { size: 10, color: [0.3, 0.32, 0.38], gapBefore: 3, indent: 14, bar: true },
  note: { size: 8.5, color: [0.55, 0.57, 0.62], gapBefore: 2 },
};

const LINE_RATIO = 1.62;

// 说话者色板：多人 RP 记录里，同一人的名字始终同色，翻页时也能一眼认出谁在说。
// 颜色都压过亮度，保证在白纸上可读。
const SPEAKER_PALETTE = [
  [0.15, 0.42, 0.6], // 蓝
  [0.62, 0.28, 0.42], // 洋红
  [0.13, 0.47, 0.38], // 青绿
  [0.72, 0.42, 0.12], // 橙
  [0.35, 0.32, 0.66], // 靛
  [0.55, 0.24, 0.24], // 砖红
  [0.25, 0.42, 0.24], // 橄榄
  [0.45, 0.28, 0.55], // 紫
  [0.2, 0.38, 0.52], // 灰蓝
  [0.6, 0.35, 0.2], // 赭
  [0.3, 0.45, 0.55], // 石板
  [0.5, 0.3, 0.38], // 玫瑰
];

// 从 speaker 块文本里取出「说话者」部分（形如 `名字（10001） · 时间`）
function speakerKey(text) {
  return String(text).split('（')[0].split('(')[0].trim() || String(text);
}

// 按名字哈希取色：跨文档稳定（同一个人在任何一份导出里都是同色）。
// 注意：renderPdf 内部不用这个 —— 它按「出现顺序」分配，保证同一份文档内不撞色。
function speakerColor(text) {
  const key = speakerKey(text);
  let h = 0;
  for (const ch of key) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return SPEAKER_PALETTE[h % SPEAKER_PALETTE.length];
}

function isCJK(cp) {
  return (
    (cp >= 0x1100 && cp <= 0x11ff) ||
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x20000 && cp <= 0x2fa1f)
  );
}

const BREAK_AFTER = new Set(Array.from('，。！？；：、）】》」』…—·,.!?;:)]}　 '));

function isBreakAfter(ch) {
  return isCJK(ch.codePointAt(0)) || BREAK_AFTER.has(ch);
}

function pad4(buf) {
  const rem = buf.length % 4;
  return rem === 0 ? buf : Buffer.concat([buf, Buffer.alloc(4 - rem)]);
}

function pdfTextString(str) {
  if (/^[\x20-\x7e]*$/.test(str)) return `(${str.replace(/[\\()]/g, (c) => '\\' + c)})`;
  const buf = Buffer.from('\ufeff' + str, 'utf16le');
  for (let i = 0; i + 1 < buf.length; i += 2) {
    const t = buf[i];
    buf[i] = buf[i + 1];
    buf[i + 1] = t;
  }
  return `<${buf.toString('hex').toUpperCase()}>`;
}

function streamObj(dict, data) {
  return Buffer.concat([
    Buffer.from(`<< ${dict} >>\nstream\n`, 'latin1'),
    data,
    Buffer.from('\nendstream', 'latin1'),
  ]);
}

function utf16Hex(cp) {
  if (cp <= 0xffff) return cp.toString(16).toUpperCase().padStart(4, '0');
  const v = cp - 0x10000;
  const hi = 0xd800 + (v >> 10);
  const lo = 0xdc00 + (v & 0x3ff);
  return hi.toString(16).toUpperCase().padStart(4, '0') + lo.toString(16).toUpperCase().padStart(4, '0');
}

function buildToUnicode(unicodeForCid) {
  const items = [];
  for (let cid = 1; cid < unicodeForCid.length; cid++) {
    if (unicodeForCid[cid]) items.push({ cid, cp: unicodeForCid[cid] });
  }
  const out = [
    '/CIDInit /ProcSet findresource begin',
    '12 dict begin',
    'begincmap',
    '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def',
    '/CMapName /Adobe-Identity-UCS def',
    '/CMapType 2 def',
    '1 begincodespacerange',
    '<0000> <FFFF>',
    'endcodespacerange',
  ];
  for (let i = 0; i < items.length; i += 100) {
    const chunk = items.slice(i, i + 100);
    out.push(`${chunk.length} beginbfchar`);
    for (const it of chunk) {
      out.push(`<${it.cid.toString(16).toUpperCase().padStart(4, '0')}> <${utf16Hex(it.cp)}>`);
    }
    out.push('endbfchar');
  }
  out.push('endcmap', 'CMapName currentdict /CMap defineresource pop', 'end', 'end');
  return out.join('\n');
}

function buildWArray(widths) {
  const parts = [];
  let i = 1;
  while (i < widths.length) {
    const end = Math.min(widths.length, i + 100);
    parts.push(`${i} [${widths.slice(i, end).join(' ')}]`);
    i = end;
  }
  return parts.join(' ');
}

function makeSubsetTag(name) {
  let h = 0x811c9dc5;
  for (let i = 0; i < name.length; i++) {
    h ^= name.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  let tag = '';
  for (let i = 0; i < 6; i++) {
    tag += String.fromCharCode(65 + ((h >>> (i * 5)) % 26));
  }
  return tag;
}

// blocks: [{ kind, text }]，kind ∈ title/label/meta/speaker/para/quote/note/rule/spacer/pagebreak
function renderPdf({ fontPath, blocks, title = '', page = PAGE_A4, margin = 56, footer = true }) {
  const font = loadFont(fontPath);
  const upem = font.unitsPerEm || 1000;
  const contentWidth = page.width - margin * 2;

  function charWidth(cp, size) {
    const adv = font.advance(font.gidFor(cp)) || Math.round(upem * 0.5);
    return (adv * size) / upem;
  }

  function measure(str, size) {
    let w = 0;
    for (const ch of str) w += charWidth(ch.codePointAt(0), size);
    return w;
  }

  function wrapText(text, size, maxWidth) {
    const out = [];
    for (const raw of String(text).split('\n')) {
      const chars = Array.from(raw);
      if (!chars.length) {
        out.push('');
        continue;
      }
      let i = 0;
      while (i < chars.length) {
        let w = 0;
        let j = i;
        let lastBreak = -1;
        while (j < chars.length) {
          const cw = charWidth(chars[j].codePointAt(0), size);
          if (w + cw > maxWidth && j > i) break;
          w += cw;
          if (isBreakAfter(chars[j])) lastBreak = j + 1;
          j++;
        }
        if (j >= chars.length) {
          out.push(chars.slice(i).join(''));
          break;
        }
        const end = lastBreak > i ? lastBreak : j;
        out.push(chars.slice(i, end).join('').replace(/\s+$/, ''));
        i = end;
        while (i < chars.length && chars[i] === ' ') i++;
      }
    }
    return out.length ? out : [''];
  }

  // ---- 1. blocks -> 逻辑行 ----
  // 说话者按「首次出现顺序」分配色板颜色，同一份文档内保证不撞色（最多到色板长度）。
  const speakerAssign = new Map();
  function colorForSpeaker(text) {
    const key = speakerKey(text);
    if (!speakerAssign.has(key)) {
      speakerAssign.set(key, SPEAKER_PALETTE[speakerAssign.size % SPEAKER_PALETTE.length]);
    }
    return speakerAssign.get(key);
  }

  const lines = [];
  const push = (style, text) => {
    const st = STYLES[style];
    const indent = st.indent || 0;
    // 说话者按人取色（同人同色），其余样式用固定色
    const color = style === 'speaker' ? colorForSpeaker(text) : st.color;
    for (const t of wrapText(text, st.size, contentWidth - indent)) {
      lines.push({
        text: t,
        size: st.size,
        color,
        bold: !!st.bold,
        bar: !!st.bar,
        indent,
        gapBefore: lines.length ? st.gapBefore : 0,
        lh: st.size * LINE_RATIO,
      });
    }
  };

  for (const b of blocks || []) {
    if (!b) continue;
    switch (b.kind) {
      case 'title':
      case 'label':
      case 'meta':
      case 'speaker':
      case 'para':
      case 'quote':
      case 'note':
        push(b.kind, b.text == null ? '' : b.text);
        break;
      case 'rule':
        lines.push({ rule: true, gapBefore: 8, lh: 12, color: [0.82, 0.84, 0.87] });
        break;
      case 'spacer':
        lines.push({ rule: true, gapBefore: b.height || 8, lh: 0, color: null });
        break;
      case 'pagebreak':
        lines.push({ pagebreak: true, lh: 0, gapBefore: 0 });
        break;
      default:
        push('para', b.text == null ? '' : String(b.text));
    }
  }

  // ---- 2. 分页 ----
  const top = page.height - margin;
  const bottom = margin;
  const pages = [];
  let cur = [];
  let y = top;
  const newPage = () => {
    pages.push(cur);
    cur = [];
    y = top;
  };
  for (const ln of lines) {
    if (ln.pagebreak) {
      if (cur.length) newPage();
      continue;
    }
    const need = ln.gapBefore + ln.lh;
    if (y - need < bottom && cur.length) newPage();
    y -= ln.gapBefore;
    y -= ln.lh;
    cur.push(Object.assign({}, ln, { y }));
  }
  if (cur.length || !pages.length) pages.push(cur);
  if (!pages.length) pages.push([]);

  const total = pages.length;
  const footerText = footer ? `肥肥风筝猫 · 第 {P} / ${total} 页` : '';

  // ---- 3. 收集用到的码点 ----
  const cps = new Set();
  const collect = (s) => {
    for (const ch of String(s)) cps.add(ch.codePointAt(0));
  };
  collect(title);
  collect(footerText.replace('{P}', String(total)));
  for (const pg of pages) for (const ln of pg) if (ln.text) collect(ln.text);

  const subset = subsetFont(font, [...cps]);

  // ---- 4. 组装 PDF 对象 ----
  const objects = [];
  const add = (body) => {
    objects.push(body);
    return objects.length;
  };

  add(null); // 1 Catalog
  add(null); // 2 Pages

  const psName = (path.basename(fontPath).replace(/\.[^.]+$/, '').replace(/[^A-Za-z0-9]/g, '') || 'CJKFont').slice(0, 32);
  const subsetTag = makeSubsetTag(psName + title);
  const baseFontName = `${subsetTag}+${psName}`;
  const scale = (v) => Math.round((v * 1000) / upem);

  add(`<< /Type /Font /Subtype /Type0 /BaseFont /${baseFontName} /Encoding /Identity-H /DescendantFonts [4 0 R] /ToUnicode 7 0 R >>`);
  add(
    `<< /Type /Font /Subtype /CIDFontType2 /BaseFont /${baseFontName} ` +
      `/CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> ` +
      `/FontDescriptor 5 0 R /DW ${subset.widths[0] || 1000} ` +
      `/W [${buildWArray(subset.widths)}] /CIDToGIDMap /Identity >>`
  );
  add(
    `<< /Type /FontDescriptor /FontName /${baseFontName} /Flags 4 ` +
      `/FontBBox [${subset.bbox.map(scale).join(' ')}] /ItalicAngle 0 ` +
      `/Ascent ${scale(subset.ascent)} /Descent ${scale(subset.descent)} ` +
      `/CapHeight ${Math.round(scale(subset.ascent) * 0.72)} /StemV 80 /FontFile2 6 0 R >>`
  );
  const fontCompressed = zlib.deflateSync(subset.sfnt, { level: 9 });
  add(streamObj(`/Length ${fontCompressed.length} /Length1 ${subset.sfnt.length} /Filter /FlateDecode`, fontCompressed));

  const toUni = Buffer.from(buildToUnicode(subset.unicodeForCid), 'latin1');
  const toUniCompressed = zlib.deflateSync(toUni, { level: 9 });
  add(streamObj(`/Length ${toUniCompressed.length} /Filter /FlateDecode`, toUniCompressed));

  add(`<< /Title ${pdfTextString(title || '肥肥风筝猫 导出')} /Producer (FatCat Bot) /Creator (FatCat Bot) >>`); // 8 Info

  const hexOf = (str) => {
    let s = '';
    for (const ch of str) s += subset.cidFor(ch.codePointAt(0)).toString(16).toUpperCase().padStart(4, '0');
    return s;
  };

  const fAscent = (subset.ascent / upem);
  const fDescent = (subset.descent / upem);
  const kids = [];

  pages.forEach((pg, pageIndex) => {
    const ops = [];
    for (const ln of pg) {
      const x = margin + (ln.indent || 0);
      if (ln.rule) {
        if (ln.color && ln.lh) {
          const ry = (ln.y + ln.lh * 0.45).toFixed(2);
          ops.push(`0.82 0.84 0.87 RG 0.7 w ${margin} ${ry} m ${(page.width - margin).toFixed(2)} ${ry} l S`);
        }
        continue;
      }
      const contentH = (fAscent - fDescent) * ln.size;
      const baseline = ln.y + (ln.lh - contentH) / 2 + fAscent * ln.size;
      if (ln.bar) {
        const bx = (margin + (ln.indent || 0) - 7).toFixed(2);
        ops.push(
          `0.78 0.82 0.88 RG 2.2 w ${bx} ${ln.y.toFixed(2)} m ${bx} ${(ln.y + ln.lh).toFixed(2)} l S`
        );
      }
      const [r, g, b] = ln.color;
      ops.push('BT');
      ops.push('/F1 ' + ln.size + ' Tf');
      // Tr（文本渲染模式）属于图形状态，会跨 BT/ET 保留，
      // 所以每行都必须显式设置：加粗用 2（填充+描边），正文用 0。
      ops.push(`${ln.bold ? 2 : 0} Tr`);
      ops.push(`${r} ${g} ${b} rg`);
      if (ln.bold) ops.push(`${r} ${g} ${b} RG 0.35 w`);
      ops.push(`1 0 0 1 ${x.toFixed(2)} ${baseline.toFixed(2)} Tm`);
      ops.push(`<${hexOf(ln.text)}> Tj`);
      ops.push('ET');
    }

    if (footer) {
      const text = `肥肥风筝猫 · 第 ${pageIndex + 1} / ${total} 页`;
      const w = measure(text, 8);
      const fy = margin * 0.45;
      ops.push('BT');
      ops.push('/F1 8 Tf');
      ops.push('0 Tr');
      ops.push('0.6 0.62 0.66 rg');
      ops.push(`1 0 0 1 ${((page.width - w) / 2).toFixed(2)} ${fy.toFixed(2)} Tm`);
      ops.push(`<${hexOf(text)}> Tj`);
      ops.push('ET');
    }

    const content = Buffer.from(ops.join('\n'), 'latin1');
    const compressed = zlib.deflateSync(content, { level: 9 });
    const contentN = add(streamObj(`/Length ${compressed.length} /Filter /FlateDecode`, compressed));
    const pageN = add(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${page.width.toFixed(2)} ${page.height.toFixed(2)}] ` +
        `/Resources << /Font << /F1 3 0 R >> >> /Contents ${contentN} 0 R >>`
    );
    kids.push(`${pageN} 0 R`);
  });

  objects[0] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[1] = `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${kids.length} >>`;

  // ---- 5. 序列化 ----
  const chunks = [];
  let offset = 0;
  const offsets = [];
  const emit = (buf) => {
    chunks.push(buf);
    offset += buf.length;
  };
  emit(Buffer.from('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n', 'latin1'));
  for (let i = 0; i < objects.length; i++) {
    offsets[i + 1] = offset;
    emit(Buffer.from(`${i + 1} 0 obj\n`, 'latin1'));
    const body = objects[i];
    emit(Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'latin1'));
    emit(Buffer.from('\nendobj\n', 'latin1'));
  }
  const xrefOffset = offset;
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let n = 1; n <= objects.length; n++) {
    xref += `${String(offsets[n]).padStart(10, '0')} 00000 n \n`;
  }
  xref += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info 8 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  emit(Buffer.from(xref, 'latin1'));

  return Buffer.concat(chunks);
}

module.exports = { renderPdf, PAGE_A4, speakerColor, SPEAKER_PALETTE };
