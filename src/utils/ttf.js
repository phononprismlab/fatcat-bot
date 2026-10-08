'use strict';
const fs = require('node:fs');

// 极简 TrueType 解析器：只取 PDF 嵌入（子集化）所需的表。
// 支持单面 .ttf 与 .ttc 字体集（取第 0 面）。OTF/CFF 暂不支持。

const TAG_TTCF = 0x74746366;

function readTableDirectory(buf, base) {
  const numTables = buf.readUInt16BE(base + 4);
  const tables = {};
  for (let i = 0; i < numTables; i++) {
    const off = base + 12 + i * 16;
    const tag = buf.toString('ascii', off, off + 4);
    tables[tag] = { offset: buf.readUInt32BE(off + 8), length: buf.readUInt32BE(off + 12) };
  }
  return tables;
}

function parseCmap4(buf, sub) {
  const segCount = buf.readUInt16BE(sub + 6) / 2;
  const endBase = sub + 14;
  const startBase = endBase + segCount * 2 + 2;
  const deltaBase = startBase + segCount * 2;
  const rangeBase = deltaBase + segCount * 2;
  return function gidFor(code) {
    if (code > 0xffff) return 0;
    for (let i = 0; i < segCount; i++) {
      const end = buf.readUInt16BE(endBase + i * 2);
      if (code <= end) {
        const start = buf.readUInt16BE(startBase + i * 2);
        if (code < start) return 0;
        const delta = buf.readInt16BE(deltaBase + i * 2);
        const rangeOffset = buf.readUInt16BE(rangeBase + i * 2);
        if (rangeOffset === 0) return (code + delta) & 0xffff;
        const idx = rangeBase + i * 2 + rangeOffset + (code - start) * 2;
        if (idx + 1 >= buf.length) return 0;
        let gid = buf.readUInt16BE(idx);
        if (gid !== 0) gid = (gid + delta) & 0xffff;
        return gid;
      }
    }
    return 0;
  };
}

function parseCmap12(buf, sub) {
  const nGroups = buf.readUInt32BE(sub + 12);
  const groups = [];
  for (let i = 0; i < nGroups; i++) {
    const g = sub + 16 + i * 12;
    groups.push({ start: buf.readUInt32BE(g), end: buf.readUInt32BE(g + 4), gid: buf.readUInt32BE(g + 8) });
  }
  return function gidFor(code) {
    let lo = 0;
    let hi = groups.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const g = groups[mid];
      if (code < g.start) hi = mid - 1;
      else if (code > g.end) lo = mid + 1;
      else return g.gid + (code - g.start);
    }
    return 0;
  };
}

function parseCmap(buf, table) {
  const base = table.offset;
  const n = buf.readUInt16BE(base + 2);
  const candidates = [];
  for (let i = 0; i < n; i++) {
    const rec = base + 4 + i * 8;
    const sub = base + buf.readUInt32BE(rec + 4);
    candidates.push({ format: buf.readUInt16BE(sub), sub });
  }
  const f12 = candidates.find((c) => c.format === 12);
  if (f12) return parseCmap12(buf, f12.sub);
  const f4 = candidates.find((c) => c.format === 4);
  if (f4) return parseCmap4(buf, f4.sub);
  throw new Error('字体无可用 cmap（仅支持 format 4 / 12）');
}

const cache = new Map();

function loadFont(fontPath) {
  if (cache.has(fontPath)) return cache.get(fontPath);

  const buf = fs.readFileSync(fontPath);
  let dirBase = 0;
  const sfnt = buf.readUInt32BE(0);
  if (sfnt === TAG_TTCF) {
    // TTC：取第 0 面，表偏移仍以文件起点为基准
    dirBase = buf.readUInt32BE(12);
  } else if (sfnt !== 0x00010000 && sfnt !== 0x74727565) {
    throw new Error('不是有效的 TrueType 字体（可能是 OTF/CFF，暂不支持）');
  }

  const tables = readTableDirectory(buf, dirBase);
  const head = tables.head;
  const hhea = tables.hhea;
  const hmtx = tables.hmtx;
  const maxp = tables.maxp;
  const cmap = tables.cmap;
  if (!head || !hhea || !hmtx || !maxp || !cmap) throw new Error('字体缺少必要表(head/hhea/hmtx/maxp/cmap)');
  if (!tables.glyf || !tables.loca) throw new Error('字体缺少 glyf/loca（可能是 CFF 轮廓，暂不支持）');

  const unitsPerEm = buf.readUInt16BE(head.offset + 18) || 1000;
  const bbox = [
    buf.readInt16BE(head.offset + 36),
    buf.readInt16BE(head.offset + 38),
    buf.readInt16BE(head.offset + 40),
    buf.readInt16BE(head.offset + 42),
  ];
  const indexToLocFormat = buf.readInt16BE(head.offset + 50);
  const numGlyphs = buf.readUInt16BE(maxp.offset + 4);
  const numberOfHMetrics = buf.readUInt16BE(hhea.offset + 34);
  const ascent = buf.readInt16BE(hhea.offset + 4);
  const descent = buf.readInt16BE(hhea.offset + 6);
  const gidFor = parseCmap(buf, cmap);

  function loca(gid) {
    const b = tables.loca.offset;
    if (indexToLocFormat === 0) return buf.readUInt16BE(b + gid * 2) * 2;
    return buf.readUInt32BE(b + gid * 4);
  }

  function glyphRange(gid) {
    if (gid >= numGlyphs) return [loca(numGlyphs), loca(numGlyphs)];
    return [loca(gid), loca(gid + 1)];
  }

  function advance(gid) {
    const i = gid < numberOfHMetrics ? gid : numberOfHMetrics - 1;
    return buf.readUInt16BE(hmtx.offset + i * 4);
  }

  function lsb(gid) {
    if (gid < numberOfHMetrics) return buf.readInt16BE(hmtx.offset + gid * 4 + 2);
    const extra = numberOfHMetrics * 4 + (gid - numberOfHMetrics) * 2;
    return buf.readInt16BE(hmtx.offset + extra);
  }

  const font = {
    path: fontPath,
    buffer: buf,
    tables,
    unitsPerEm,
    bbox,
    ascent,
    descent,
    numGlyphs,
    indexToLocFormat,
    numberOfHMetrics,
    gidFor,
    loca,
    glyphRange,
    advance,
    lsb,
    metric: (gid) => ({ advance: advance(gid), lsb: lsb(gid) }),
    glyphData(gid) {
      const [s, e] = glyphRange(gid);
      if (e <= s) return buf.subarray(0, 0);
      return buf.subarray(tables.glyf.offset + s, tables.glyf.offset + e);
    },
  };
  cache.set(fontPath, font);
  return font;
}

module.exports = { loadFont };
