'use strict';

// TrueType 子集化：只保留文档里实际用到的字形，把 9MB 的中文字体压到几十 KB。
// 输出仍是标准 SFNT，可直接作为 PDF 的 FontFile2 嵌入。
//
// CID 约定：子集字体里的新 GID 直接当作 PDF 的 CID 用（/CIDToGIDMap /Identity），
// 因此 CID 1..N 与字形一一对应，无需额外映射表。

function pad4(buf) {
  const rem = buf.length % 4;
  if (rem === 0) return buf;
  return Buffer.concat([buf, Buffer.alloc(4 - rem)]);
}

function tableChecksum(data) {
  let sum = 0;
  for (let i = 0; i < data.length; i += 4) {
    sum = (sum + data.readUInt32BE(i)) >>> 0;
  }
  return sum >>> 0;
}

// tables: { tag: Buffer }；返回完整 SFNT（含 checkSumAdjustment）
function buildSfnt(tables) {
  const list = Object.keys(tables)
    .filter((tag) => tables[tag] && tables[tag].length >= 0)
    .sort()
    .map((tag) => ({ tag, data: tables[tag] }));

  const numTables = list.length;
  let searchRange = 1;
  let entrySelector = 0;
  while (searchRange * 2 <= numTables) {
    searchRange *= 2;
    entrySelector++;
  }
  searchRange *= 16;
  const rangeShift = numTables * 16 - searchRange;

  const header = Buffer.alloc(12);
  header.writeUInt32BE(0x00010000, 0);
  header.writeUInt16BE(numTables, 4);
  header.writeUInt16BE(searchRange, 6);
  header.writeUInt16BE(entrySelector, 8);
  header.writeUInt16BE(rangeShift, 10);

  const directory = Buffer.alloc(numTables * 16);
  const parts = [header, directory];
  let offset = 12 + numTables * 16;
  const entries = [];

  for (let i = 0; i < numTables; i++) {
    const { tag, data } = list[i];
    const padded = pad4(data);
    entries.push({ tag, checksum: tableChecksum(padded), offset, length: data.length });
    offset += padded.length;
    parts.push(padded);
  }

  for (let i = 0; i < numTables; i++) {
    const e = entries[i];
    const p = i * 16;
    directory.write(e.tag, p, 4, 'ascii');
    directory.writeUInt32BE(e.checksum, p + 4);
    directory.writeUInt32BE(e.offset, p + 8);
    directory.writeUInt32BE(e.length, p + 12);
  }

  const out = Buffer.concat(parts);
  const headEntry = entries.find((e) => e.tag === 'head');
  if (headEntry) {
    out.writeUInt32BE(0, headEntry.offset + 8);
    const total = tableChecksum(out);
    out.writeUInt32BE((0xb1b0afba - total) >>> 0, headEntry.offset + 8);
  }
  return out;
}

function isCompositeGlyph(data) {
  return data.length >= 10 && data.readInt16BE(0) < 0;
}

// 遍历复合字形的组件记录，回调 (componentGid, gidFieldOffset)
function walkComponents(data, onComponent) {
  let p = 10;
  while (p + 4 <= data.length) {
    const flags = data.readUInt16BE(p);
    const gid = data.readUInt16BE(p + 2);
    onComponent(gid, p + 2);
    let len = 4;
    len += flags & 0x0001 ? 4 : 2;
    if (flags & 0x0008) len += 2;
    else if (flags & 0x0040) len += 4;
    else if (flags & 0x0080) len += 8;
    p += len;
    if (!(flags & 0x0020)) break;
  }
}

function buildCmap4(entries) {
  // entries: [{ code, gid }]，按 code 升序
  const segments = [];
  let i = 0;
  while (i < entries.length) {
    const start = entries[i].code;
    const startGid = entries[i].gid;
    let j = i + 1;
    while (
      j < entries.length &&
      entries[j].code === entries[j - 1].code + 1 &&
      entries[j].gid === entries[j - 1].gid + 1
    ) {
      j++;
    }
    segments.push({ start, end: entries[j - 1].code, delta: (startGid - start) & 0xffff });
    i = j;
  }
  segments.push({ start: 0xffff, end: 0xffff, delta: 1 });

  const segCount = segments.length;
  let searchRange = 1;
  let entrySelector = 0;
  while (searchRange * 2 <= segCount) {
    searchRange *= 2;
    entrySelector++;
  }
  searchRange *= 2;
  const rangeShift = segCount * 2 - searchRange;

  const length = 16 + segCount * 8;
  const out = Buffer.alloc(length);
  out.writeUInt16BE(4, 0);
  out.writeUInt16BE(length, 2);
  out.writeUInt16BE(0, 4);
  out.writeUInt16BE(segCount * 2, 6);
  out.writeUInt16BE(searchRange, 8);
  out.writeUInt16BE(entrySelector, 10);
  out.writeUInt16BE(rangeShift, 12);

  const endBase = 14;
  const startBase = endBase + segCount * 2 + 2;
  const deltaBase = startBase + segCount * 2;
  const rangeBase = deltaBase + segCount * 2;
  for (let s = 0; s < segCount; s++) {
    out.writeUInt16BE(segments[s].end, endBase + s * 2);
    out.writeUInt16BE(segments[s].start, startBase + s * 2);
    out.writeInt16BE(segments[s].delta > 0x7fff ? segments[s].delta - 0x10000 : segments[s].delta, deltaBase + s * 2);
    out.writeUInt16BE(0, rangeBase + s * 2);
  }
  return out;
}

// font: loadFont() 的结果；codepoints: 需要保留的 Unicode 码点数组
// 返回 { sfnt, numGlyphs, cidFor, widths, unicodeForCid, ... }
function subsetFont(font, codepoints) {
  const copyTables = ['head', 'hhea', 'maxp', 'name', 'post', 'OS/2', 'cvt ', 'fpgm', 'prep', 'gasp'];

  // 1. 收集用到的字形（oldGid -> 代表码点，-1 表示仅作组件）
  const used = new Map();
  for (const cp of codepoints) {
    const g = font.gidFor(cp);
    if (g !== 0 && !used.has(g)) used.set(g, cp);
  }

  // 2. 递归补入复合字形的组件
  const queue = [...used.keys()];
  while (queue.length) {
    const g = queue.pop();
    walkComponents(font.glyphData(g), (compGid) => {
      if (compGid !== 0 && !used.has(compGid)) {
        used.set(compGid, -1);
        queue.push(compGid);
      }
    });
  }

  // 3. 分配新 GID（0 号保留给 .notdef）
  const ordered = [...used.keys()].sort((a, b) => a - b);
  const oldToNew = new Map();
  let next = 1;
  for (const g of ordered) oldToNew.set(g, next++);
  const numGlyphs = next;
  const newToOld = [0, ...ordered];

  // 4. 重建 glyf / loca
  const glyphParts = [];
  const locaOffsets = [];
  let glyfLen = 0;
  const emitGlyph = (oldGid) => {
    let data = font.glyphData(oldGid);
    if (isCompositeGlyph(data)) {
      const out = Buffer.from(data);
      walkComponents(out, (compGid, fieldOffset) => {
        out.writeUInt16BE(oldToNew.get(compGid) || 0, fieldOffset);
      });
      data = out;
    }
    locaOffsets.push(glyfLen);
    const padded = pad4(data);
    glyphParts.push(padded);
    glyfLen += padded.length;
  };
  emitGlyph(0); // .notdef
  for (const g of ordered) emitGlyph(g);
  locaOffsets.push(glyfLen);

  const glyf = Buffer.concat(glyphParts);
  const loca = Buffer.alloc(locaOffsets.length * 4);
  locaOffsets.forEach((v, i) => loca.writeUInt32BE(v, i * 4));

  // 5. 重建 hmtx（每字形一条 longHorMetric）
  const hmtx = Buffer.alloc(numGlyphs * 4);
  newToOld.forEach((oldGid, i) => {
    const m = font.metric(oldGid);
    hmtx.writeUInt16BE(Math.min(0xffff, Math.max(0, m.advance)), i * 4);
    hmtx.writeInt16BE(m.lsb, i * 4 + 2);
  });

  // 6. head / hhea / maxp 打补丁
  const tables = {};
  for (const tag of copyTables) {
    const t = font.tables[tag];
    if (t) tables[tag] = Buffer.from(font.buffer.subarray(t.offset, t.offset + t.length));
  }
  if (tables.head) tables.head.writeInt16BE(1, 50); // indexToLocFormat = long
  if (tables.hhea) tables.hhea.writeUInt16BE(numGlyphs, 34);
  if (tables.maxp) tables.maxp.writeUInt16BE(numGlyphs, 4);

  tables.hmtx = hmtx;
  tables.loca = loca;
  tables.glyf = glyf;

  // 7. cmap（format 4）：码点 -> 新 GID
  // 关键：中文字体里多个码点常共用同一字形（many-to-one），
  // 所以必须按「码点」建表，不能按「字形」反推，否则会漏掉同形码点。
  const cmapEntries = [];
  const seenCode = new Set();
  for (const cp of codepoints) {
    if (cp < 0 || cp > 0xfffe || seenCode.has(cp)) continue;
    const g = font.gidFor(cp);
    if (g === 0) continue;
    const n = oldToNew.get(g);
    if (!n) continue;
    seenCode.add(cp);
    cmapEntries.push({ code: cp, gid: n });
  }
  cmapEntries.sort((a, b) => a.code - b.code);
  const cmap4 = buildCmap4(cmapEntries);
  const cmap = Buffer.alloc(12 + cmap4.length);
  cmap.writeUInt16BE(0, 0);
  cmap.writeUInt16BE(1, 2);
  cmap.writeUInt16BE(3, 4); // Windows
  cmap.writeUInt16BE(1, 6); // BMP
  cmap.writeUInt32BE(12, 8);
  cmap4.copy(cmap, 12);
  tables.cmap = cmap;

  const sfnt = buildSfnt(tables);

  // 8. 供 PDF 使用的映射
  const upem = font.unitsPerEm || 1000;
  const widths = newToOld.map((g) => Math.round((font.advance(g) * 1000) / upem));
  const unicodeForCid = new Array(numGlyphs).fill(0);
  for (const [oldGid, cp] of used) {
    if (cp < 0) continue;
    const n = oldToNew.get(oldGid);
    if (n != null && !unicodeForCid[n]) unicodeForCid[n] = cp;
  }

  return {
    sfnt,
    numGlyphs,
    unitsPerEm: upem,
    bbox: font.bbox,
    ascent: font.ascent,
    descent: font.descent,
    cidFor(code) {
      const g = font.gidFor(code);
      if (g === 0) return 0;
      return oldToNew.get(g) || 0;
    },
    widths,
    unicodeForCid,
    glyphCount: ordered.length,
  };
}

module.exports = { subsetFont, buildSfnt };
