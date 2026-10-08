'use strict';

// 数据访问层：所有 SQL 都集中在这里
function createRepo(db) {
  const now = () => Date.now();

  // ---- 用户 ----
  function upsertUser(qqId, name) {
    const existing = db.prepare('SELECT qq_id FROM users WHERE qq_id = ?').get(qqId);
    if (!existing) {
      db.prepare('INSERT INTO users (qq_id, display_name, created_at) VALUES (?,?,?)').run(qqId, name || '', now());
    } else if (name) {
      db.prepare('UPDATE users SET display_name = ? WHERE qq_id = ?').run(name, qqId);
    }
  }
  function getUser(qqId) {
    return db.prepare('SELECT * FROM users WHERE qq_id = ?').get(qqId);
  }
  function listUsers() {
    return db.prepare('SELECT * FROM users').all();
  }
  function setUserSetting(qqId, field, value) {
    const allowed = { boomerang_days: true, summary_on: true };
    if (!allowed[field]) throw new Error('非法字段: ' + field);
    db.prepare(`UPDATE users SET ${field} = ? WHERE qq_id = ?`).run(value, qqId);
  }

  // ---- 会话 ----
  function createSession(qqId, groupId) {
    const info = db.prepare('INSERT INTO sessions (qq_id, group_id, start_time, status) VALUES (?,?,?,?)')
      .run(qqId, groupId, now(), 'open');
    return Number(info.lastInsertRowid);
  }
  function getOpenSession(qqId) {
    return db.prepare("SELECT * FROM sessions WHERE qq_id = ? AND status = 'open' ORDER BY id DESC LIMIT 1").get(qqId);
  }
  function getOpenSessionsByGroup(groupId) {
    return db.prepare("SELECT * FROM sessions WHERE group_id = ? AND status = 'open'").all(groupId);
  }
  function archiveSession(id) {
    db.prepare("UPDATE sessions SET status = 'archived', end_time = ? WHERE id = ?").run(now(), id);
  }

  // ---- 发言 ----
  function addMessage(sessionId, qqId, name, content, ts, isRecorder) {
    db.prepare('INSERT INTO messages (session_id, qq_id, name, content, ts, is_recorder) VALUES (?,?,?,?,?,?)')
      .run(sessionId, qqId, name, content, ts, isRecorder ? 1 : 0);
  }
  function getMessages(sessionId) {
    return db.prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY id ASC').all(sessionId);
  }

  // ---- 片段 ----
  function createSnippet(sessionId, qqId, summary) {
    const info = db.prepare('INSERT INTO snippets (session_id, qq_id, summary, created_at) VALUES (?,?,?,?)')
      .run(sessionId, qqId, summary || null, now());
    return Number(info.lastInsertRowid);
  }
  function listSnippets(qqId, limit = 1000) {
    return db.prepare('SELECT * FROM snippets WHERE qq_id = ? ORDER BY created_at DESC LIMIT ?').all(qqId, limit);
  }
  function setSnippetSent(id, ts) {
    db.prepare('UPDATE snippets SET last_sent = ? WHERE id = ?').run(ts, id);
  }

  // ---- 资料 ----
  function addFile(qqId, filename, filePath, contentText) {
    const info = db.prepare('INSERT INTO files (qq_id, filename, path, content_text, uploaded_at) VALUES (?,?,?,?,?)')
      .run(qqId, filename, filePath, contentText, now());
    return Number(info.lastInsertRowid);
  }
  function listFiles(qqId) {
    return db.prepare('SELECT * FROM files WHERE qq_id = ? ORDER BY uploaded_at DESC').all(qqId);
  }
  function setFileSent(id, ts) {
    db.prepare('UPDATE files SET last_sent = ? WHERE id = ?').run(ts, id);
  }

  // ---- 检索索引 ----
  function indexAdd(content, owner, kind, refId) {
    if (!content) return;
    db.prepare('INSERT INTO search_index (content, owner, kind, ref_id) VALUES (?,?,?,?)')
      .run(content, owner, kind, String(refId));
  }
  function search(owner, kw, limit = 20) {
    const clean = String(kw).replace(/["'()*:^\[\]]/g, ' ').trim();
    if (!clean) return [];
    if (clean.length >= 3) {
      try {
        return db.prepare('SELECT owner, kind, ref_id, content FROM search_index WHERE search_index MATCH ? AND owner = ? LIMIT ?')
          .all(clean, owner, limit);
      } catch (e) {
        // 落到 LIKE
      }
    }
    return db.prepare('SELECT owner, kind, ref_id, content FROM search_index WHERE owner = ? AND content LIKE ? LIMIT ?')
      .all(owner, `%${clean}%`, limit);
  }

  // ---- 回旋镖候选 ----
  function pickBoomerangCandidate(qqId, cutoff) {
    const s = db.prepare('SELECT id, summary, created_at, last_sent FROM snippets WHERE qq_id = ? AND created_at <= ? AND (last_sent IS NULL OR last_sent <= ?) ORDER BY created_at ASC LIMIT 1')
      .get(qqId, cutoff, cutoff);
    if (s) return { kind: 'snippet', id: s.id, summary: s.summary, created_at: s.created_at };
    const f = db.prepare('SELECT id, filename, content_text, uploaded_at AS created_at, last_sent FROM files WHERE qq_id = ? AND uploaded_at <= ? AND (last_sent IS NULL OR last_sent <= ?) ORDER BY uploaded_at ASC LIMIT 1')
      .get(qqId, cutoff, cutoff);
    if (f) return { kind: 'file', id: f.id, summary: f.filename, created_at: f.created_at };
    return null;
  }

  // ---- 统计 ----
  function stats(qqId) {
    const snippets = db.prepare('SELECT COUNT(*) AS c FROM snippets WHERE qq_id = ?').get(qqId).c;
    const files = db.prepare('SELECT COUNT(*) AS c FROM files WHERE qq_id = ?').get(qqId).c;
    const last = db.prepare('SELECT created_at FROM snippets WHERE qq_id = ? ORDER BY created_at DESC LIMIT 1').get(qqId);
    return { snippets, files, lastCreatedAt: last ? last.created_at : null };
  }

  return {
    upsertUser, getUser, listUsers, setUserSetting,
    createSession, getOpenSession, getOpenSessionsByGroup, archiveSession,
    addMessage, getMessages,
    createSnippet, listSnippets, setSnippetSent,
    addFile, listFiles, setFileSent,
    indexAdd, search,
    pickBoomerangCandidate, stats,
  };
}

module.exports = { createRepo };
