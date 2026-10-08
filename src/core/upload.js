'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { sanitizeFilename } = require('../utils/filenames');

// v1 支持上传的文本格式
const TEXT_EXTS = new Set(['.txt', '.md', '.markdown', '.text']);
const MAX_BYTES = 2 * 1024 * 1024; // 2MB

function extOf(name) {
  const i = String(name || '').lastIndexOf('.');
  return i >= 0 ? String(name).slice(i).toLowerCase() : '';
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
  const text = buffer.toString('utf8');
  const dir = path.join(config.uploadsDir, String(userId));
  fs.mkdirSync(dir, { recursive: true });
  const safeName = sanitizeFilename(filename || 'upload.txt');
  const saved = path.join(dir, `${Date.now()}_${safeName}`);
  fs.writeFileSync(saved, buffer);

  const id = repo.addFile(userId, filename || safeName, saved, text);
  repo.indexAdd(text, userId, 'file', id);
  return { ok: true, id, name: filename || safeName, chars: text.length };
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

module.exports = { ingestUpload, ingestBytes, TEXT_EXTS, MAX_BYTES };
