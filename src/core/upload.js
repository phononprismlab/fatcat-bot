'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { sanitizeFilename } = require('../utils/filenames');

// v1 支持上传的文本格式
const TEXT_EXTS = new Set(['.txt', '.md', '.markdown', '.text']);
const MAX_BYTES = 2 * 1024 * 1024; // 2MB（单文件）
// 单用户资料库字符总量上限（托管档防单人塞满磁盘）。0 = 不限制。
const DEFAULT_USER_QUOTA_CHARS = 2_000_000;

function extOf(name) {
  const i = String(name || '').lastIndexOf('.');
  return i >= 0 ? String(name).slice(i).toLowerCase() : '';
}

// 解码文本：优先 UTF-8（严格模式，遇到非法字节即失败），失败回退 GB18030。
// 国内用户手上的 .txt 有相当比例是 GBK/GB18030（Windows 记事本旧默认），
// 若一律按 UTF-8 解会整篇乱码，且乱码同样进 FTS 索引，搜索一并失效。
function decodeText(buffer) {
  let buf = buffer;
  // 去 UTF-8 BOM
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    buf = buf.subarray(3);
    return { text: buf.toString('utf8'), encoding: 'utf-8 (BOM)' };
  }
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(buf);
    return { text, encoding: 'utf-8' };
  } catch (e) {
    // 回退 GB18030（TextDecoder 原生支持，覆盖 GBK / GB2312）
    try {
      const text = new TextDecoder('gb18030').decode(buf);
      return { text, encoding: 'gb18030' };
    } catch (e2) {
      return { text: buf.toString('utf8'), encoding: 'utf-8 (含非法字节，可能有乱码)' };
    }
  }
}

// 把一段文本/字节流收进用户资料库
function ingestBytes({ config, repo, userId, filename, buffer }) {
  const ext = extOf(filename);
  if (!TEXT_EXTS.has(ext)) {
    return { ok: false, reason: `暂不支持 ${ext || '该'} 格式（目前支持 txt / md）` };
  }
  if (buffer.length > MAX_BYTES) {
    return { ok: false, reason: `文件过大（上限 ${Math.round(MAX_BYTES / 1024 / 1024)}MB）` };
  }

  const { text, encoding } = decodeText(buffer);

  const quota = config.userQuotaChars === undefined ? DEFAULT_USER_QUOTA_CHARS : config.userQuotaChars;
  if (quota > 0) {
    const used = repo.storageChars(userId);
    if (used + text.length > quota) {
      return {
        ok: false,
        reason: `资料库已满（上限约 ${Math.round(quota / 10000)} 万字，已用 ${Math.round(used / 10000)} 万字）。` +
          `可以先用 /导出 把旧资料带走，再删除一些腾出空间`,
      };
    }
  }

  const dir = path.join(config.uploadsDir, String(userId));
  fs.mkdirSync(dir, { recursive: true });
  const safeName = sanitizeFilename(filename || 'upload.txt');
  const saved = path.join(dir, `${Date.now()}_${safeName}`);
  fs.writeFileSync(saved, buffer);

  const id = repo.addFile(userId, filename || safeName, saved, text);
  repo.indexAdd(text, userId, 'file', id);
  return { ok: true, id, name: filename || safeName, chars: text.length, encoding };
}

// 读取来源：http(s) url 或本地路径（含 file://）
async function readSource(source) {
  if (/^https?:\/\//i.test(source)) {
    const resp = await fetch(source);
    if (!resp.ok) throw new Error('下载失败 HTTP ' + resp.status);
    return Buffer.from(await resp.arrayBuffer());
  }
  let p = source;
  if (p.startsWith('file://')) {
    p = decodeURIComponent(p.slice('file://'.length));
    p = p.replace(/^\/([A-Za-z]:)/, '$1'); // windows: /C:/... -> C:/...
  }
  return fs.readFileSync(p);
}

// 完整流程：拿地址 -> 读内容 -> 入库
async function ingestUpload({ config, repo, client, userId, fileId, fileName, directUrl }) {
  let source = directUrl || null;
  let name = fileName || '';

  if (!source && fileId && client && client.getFile) {
    const res = await client.getFile(fileId);
    const data = res && res.data;
    if (data) {
      source = data.url || data.file || data.path;
      if (!name) name = data.file_name || data.name || '';
    }
    if (!source) throw new Error('无法获取文件地址');
  }
  if (!source) throw new Error('缺少文件地址');

  const buffer = await readSource(source);
  return ingestBytes({ config, repo, userId, filename: name || 'upload.txt', buffer });
}

module.exports = { ingestUpload, ingestBytes, decodeText, TEXT_EXTS, MAX_BYTES, DEFAULT_USER_QUOTA_CHARS };
