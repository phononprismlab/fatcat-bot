'use strict';
// PDF 导出验证脚本：生成样例 PDF + 导出子集字体供 FreeType 校验
const fs = require('node:fs');
const path = require('node:path');
const { loadConfig } = require('../src/config');
const { renderPdf } = require('../src/utils/pdf');
const { loadFont } = require('../src/utils/ttf');
const { subsetFont } = require('../src/utils/ttf-subset');

const rootDir = path.resolve(__dirname, '..');
const config = loadConfig(rootDir);
const outDir = path.join(rootDir, 'data', 'pdftest');
fs.mkdirSync(outDir, { recursive: true });

if (!config.fontPath) {
  console.error('找不到中文字体');
  process.exit(1);
}
console.log('字体：', config.fontPath);

const longPara =
  '那天晚上我们聊到凌晨三点，朔子突然说：「如果有一天这个群散了，这些乱七八糟的话是不是就全没了。」' +
  '我愣了一下，然后说：那就把它们留下来。先进个人的OC故事已经写了三年，她说她最怕的不是写不出来，' +
  '而是写着写着，忘了当初为什么开始写。希斯补了一句：「记忆这东西，得有人替它收着。」\n' +
  'English mixed text 2026-10-08 with numbers 1234567890 and symbols !@#$%^&*()_+-=[]{};:\'"<>,.?/~`|\\' +
  '以及一长串没有任何空格的中文段落用来测试换行是否会在合适的位置断开而不是把整个段落挤成一行导致溢出页面宽度。';

const blocks = [
  { kind: 'title', text: '口嗨片段 #42' },
  { kind: 'meta', text: '记录时间：2026-10-08 03:12' },
  { kind: 'meta', text: '归属：朔子（10086）' },
  { kind: 'meta', text: '共 8 条消息' },
  { kind: 'rule' },
  { kind: 'speaker', text: '朔子（10086） · 2026-10-08 03:12' },
  { kind: 'para', text: longPara },
  { kind: 'speaker', text: '先进个人（10010） · 2026-10-08 03:15' },
  { kind: 'para', text: '我的OC叫「回旋镖」，设定是……' },
  { kind: 'speaker', text: '希斯（10000） · 2026-10-08 03:20' },
  { kind: 'para', text: '哈哈哈哈哈哈哈哈哈哈' },
  { kind: 'rule' },
  { kind: 'label', text: '大模型总结' },
  {
    kind: 'quote',
    text:
      '三人围绕「口嗨是否值得被记录」展开讨论。朔子担心群解散后记录丢失，先进个人担忧创作初衷被遗忘，' +
      '希斯提出「记忆需要有人收着」。结论：需要一个忠实的记录者。',
  },
  { kind: 'rule' },
  { kind: 'label', text: '附件清单' },
  { kind: 'note', text: '资料 #1 · 先进个人_回旋镖设定.txt（12.4 KB）' },
  { kind: 'note', text: '资料 #2 · 当晚RP记录.txt（301 KB）' },
];

// 多页压力测试
const manyBlocks = [];
for (let i = 0; i < 40; i++) {
  manyBlocks.push({ kind: 'speaker', text: `测试用户${i}（20${String(i).padStart(3, '0')}） · 2026-10-08 0${i % 9}:00` });
  manyBlocks.push({ kind: 'para', text: `这是第 ${i} 条压力测试消息，用来验证分页、页码与长文档排版是否正确。${longPara.slice(0, 120)}` });
}

const t0 = Date.now();
const pdf = renderPdf({ fontPath: config.fontPath, blocks, title: '口嗨片段 #42' });
const pdfPath = path.join(outDir, 'sample.pdf');
fs.writeFileSync(pdfPath, pdf);
console.log(`单页 PDF：${pdfPath}  ${(pdf.length / 1024).toFixed(1)} KB  ${Date.now() - t0}ms`);

const t1 = Date.now();
const pdfMulti = renderPdf({ fontPath: config.fontPath, blocks: manyBlocks, title: '压力测试长文档' });
const pdfMultiPath = path.join(outDir, 'sample-multi.pdf');
fs.writeFileSync(pdfMultiPath, pdfMulti);
console.log(`多页 PDF：${pdfMultiPath}  ${(pdfMulti.length / 1024).toFixed(1)} KB  ${Date.now() - t1}ms`);

// 导出子集字体，交给 FreeType(PIL) 校验
const font = loadFont(config.fontPath);
const cps = new Set();
for (const ch of JSON.stringify(blocks) + JSON.stringify(manyBlocks) + '肥肥风筝猫') cps.add(ch.codePointAt(0));
const subset = subsetFont(font, [...cps]);
const subsetPath = path.join(outDir, 'subset.ttf');
fs.writeFileSync(subsetPath, subset.sfnt);
console.log(`子集字体：${subsetPath}  ${(subset.sfnt.length / 1024).toFixed(1)} KB  字形数=${subset.glyphCount}（原 ${font.numGlyphs}）`);
fs.writeFileSync(path.join(outDir, 'meta.json'), JSON.stringify({
  fontPath: config.fontPath,
  numGlyphs: subset.numGlyphs,
  glyphCount: subset.glyphCount,
  codepoints: [...cps].length,
  charset: [...cps],
  sampleText: longPara,
}, null, 2));
