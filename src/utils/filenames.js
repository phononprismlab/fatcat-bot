'use strict';

// 文件名净化（借鉴海豹骰子 filename.go 思路）
const INVALID = /[<>:"/\\|?*\x00-\x1f]/g;
const RESERVED = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;

function sanitizeFilename(name) {
  let n = String(name || '')
    .replace(/[\u0000-\u001f]/g, '')
    .replace(INVALID, '')
    .trim()
    .replace(/^[. ]+|[. ]+$/g, '');
  if (!n || n === '.' || n === '..' || RESERVED.test(n)) n = 'export';
  // 按字节截断，避免过长
  if (Buffer.byteLength(n, 'utf8') > 200) {
    let s = '';
    for (const ch of n) {
      if (Buffer.byteLength(s + ch, 'utf8') > 190) break;
      s += ch;
    }
    n = s;
  }
  return n;
}

module.exports = { sanitizeFilename };
