// 用 pdf.js 解析我们生成的 PDF，校验文本可被正确提取（即 CID 编码 + ToUnicode 正确）
// pdf.js 不入库，首次运行时从 CDN 拉到 data/pdftest/pdfjs/（该目录已被 .gitignore 忽略）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const base = path.resolve(here, '..', 'data', 'pdftest');
const pdfjsDir = path.join(base, 'pdfjs');

const PDFJS_VERSION = '4.10.38';
const ASSETS = {
  'pdf.min.mjs': `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${PDFJS_VERSION}/pdf.min.mjs`,
  'pdf.worker.min.mjs': `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${PDFJS_VERSION}/pdf.worker.min.mjs`,
};

fs.mkdirSync(pdfjsDir, { recursive: true });
for (const [name, url] of Object.entries(ASSETS)) {
  const dest = path.join(pdfjsDir, name);
  if (fs.existsSync(dest) && fs.statSync(dest).size > 1000) continue;
  process.stdout.write(`下载 pdf.js ${name} … `);
  try {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    fs.writeFileSync(dest, Buffer.from(await r.arrayBuffer()));
    console.log('OK');
  } catch (e) {
    console.log('失败：' + e.message);
    console.log('SKIP：无法获取 pdf.js，跳过文本提取校验（需联网）');
    process.exit(0);
  }
}

const pdfjsLib = await import(pathToFileURL(path.join(pdfjsDir, 'pdf.min.mjs')).href);
pdfjsLib.GlobalWorkerOptions.workerSrc = pathToFileURL(path.join(pdfjsDir, 'pdf.worker.min.mjs')).href;

const EXPECT = {
  'sample.pdf': [
    '口嗨片段 #42',
    '记录时间：2026-10-08 03:12',
    '归属：朔子（10086）',
    '共 8 条消息',
    '朔子（10086） · 2026-10-08 03:12',
    '先进个人的OC故事已经写了三年',
    'English mixed text 2026-10-08 with numbers 1234567890',
    '哈哈哈哈哈哈哈哈哈哈',
    '大模型总结',
    '记忆需要有人收着',
    '附件清单',
    '先进个人_回旋镖设定.txt',
    '肥肥风筝猫 · 第 1 / 1 页',
  ],
  'sample-multi.pdf': ['肥肥风筝猫 · 第 1 / 6 页', '肥肥风筝猫 · 第 6 / 6 页', '测试用户39'],
};

let failed = 0;
for (const [file, expects] of Object.entries(EXPECT)) {
  const p = path.join(base, file);
  const data = new Uint8Array(fs.readFileSync(p));
  const doc = await pdfjsLib.getDocument({
    data,
    useWorkerFetch: false,
    isEvalSupported: false,
    disableFontFace: true,
    verbosity: 0,
  }).promise;

  const all = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const tc = await page.getTextContent();
    all.push(tc.items.map((it) => it.str).join(''));
  }
  const text = all.join('\n');

  console.log(`\n--- ${file}（pdf.js 解析 ${doc.numPages} 页，提取 ${text.length} 字）---`);
  for (const e of expects) {
    const ok = text.includes(e);
    if (!ok) failed++;
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${e}`);
  }
  // 未映射字符（ToUnicode 缺失会变成 U+FFFD 或空）
  const bad = [...text].filter((c) => c === '\uFFFD');
  console.log(`  ${bad.length === 0 ? 'PASS' : 'FAIL'}  无替换字符 U+FFFD（${bad.length} 个）`);
  if (bad.length) failed++;
}

console.log(`\n${failed === 0 ? '结果：全部通过' : `结果：${failed} 项失败`}`);
process.exit(failed === 0 ? 0 : 1);
