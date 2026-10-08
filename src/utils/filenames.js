'use strict';
const crypto = require('node:crypto');

// 文件名净化（借鉴海豹骰子 filename.go 思路）
const INVALID = /[<>:"/\\|?*\x00-\x1f]/g;
const RESERVED = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;
const MAX_BYTES = 200;
const TRIM_BYTES = 150; // 留出空间放哈希后缀

function shortHash(s) {
  return crypto.createHash('sha1').update(String(s), 'utf8').digest('hex').slice(0, 8);
}

// 按字节裁剪（不切断多字节字符）
function trimBytes(s, maxBytes) {
  let out = '';
  for (const ch of s) {
    if (Buffer.byteLength(out + ch, 'utf8') > maxBytes) break;
    out += ch;
  }
  return out;
}

// 拆出扩展名，便于截断后把扩展名拼回来
function splitExt(name) {
  const i = name.lastIndexOf('.');
  if (i <= 0 || i === name.length - 1) return { base: name, ext: '' };
  return { base: name.slice(0, i), ext: name.slice(i) };
}

// sanitizeFilename(name, seed)
//   seed 可选：内容哈希的来源（如文件正文）。传入后，超长名会截断并附加内容哈希后缀，
//   避免「前 N 字节相同的两个长文件名」截断后撞名 —— 撞名会让导出时后写的文件静默覆盖前一个。
function sanitizeFilename(name, seed) {
  let n = String(name || '')
    .replace(/[\u0000-\u001f]/g, '')
    .replace(INVALID, '')
    .trim()
    .replace(/^[. ]+|[. ]+$/g, '');
  if (!n || n === '.' || n === '..' || RESERVED.test(n)) n = 'export';

  if (Buffer.byteLength(n, 'utf8') > MAX_BYTES) {
    const { base, ext } = splitExt(n);
    // 有内容就用内容哈希（内容不同必然不撞名）；没有就用原名哈希（至少同输入稳定）
    const suffix = '_' + shortHash(seed === undefined || seed === null ? n : seed);
    n = trimBytes(base, TRIM_BYTES) + suffix + ext;
  }
  return n;
}

module.exports = { sanitizeFilename, shortHash };
