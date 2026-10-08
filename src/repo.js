'use strict';

// 数据访问层：所有 SQL 都集中在这里。
// 分两块：机器人运行时用的最小接口 + 管理台（web admin）用的查询/变更接口。

const USER_FIELDS = new Set(['display_name', 'mode', 'boomerang_days', 'summary_on']);

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
    return db.prepare('SELECT * FROM users ORDER BY created_at ASC').all();
  }
  function setUserSetting(qqId, field, value) {
    const allowed = { boomerang_days: true, summary_on: true };
    if (!allowed[field]) throw new Error('非法字段: ' + field);
    db.prepare(`UPDATE users SET ${field} = ? WHERE qq_id = ?`).run(value, qqId);
  }
  // 单用户已占用存储（资料正文的字符数近似），用于托管档配额检查
  function storageChars(qqId) {
    const r = db.prepare('SELECT COALESCE(SUM(LENGTH(content_text)), 0) AS c FROM files WHERE qq_id = ?').get(qqId);
    return Number(r.c || 0);
  }

  // ---- 群级知情同意 ----
  function hasGroupNotice(groupId) {
    if (!groupId) return true;
    return !!db.prepare('SELECT group_id FROM group_notices WHERE group_id = ?').get(groupId);
  }
  function markGroupNotice(groupId) {
    if (!groupId) return;
    db.prepare('INSERT OR REPLACE INTO group_notices (group_id, announced_at) VALUES (?,?)').run(groupId, now());
  }
  function clearGroupNotice(groupId) {
    db.prepare('DELETE FROM group_notices WHERE group_id = ?').run(groupId);
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

  // ---- 撤回：用户行使"删除我在本群的发言"权利（真删，非标记） ----
  // 返回 { removed, sessionIds }，调用方需据此重建受影响片段的检索索引。
  function deleteMessagesByUserInGroup(qqId, groupId) {
    const rows = db.prepare(
      `SELECT m.id, m.session_id FROM messages m
       JOIN sessions s ON s.id = m.session_id
       WHERE m.qq_id = ? AND s.group_id = ?`
    ).all(qqId, groupId);
    if (!rows.length) return { removed: 0, sessionIds: [] };
    const sessionIds = [...new Set(rows.map((r) => r.session_id))];
    const del = db.prepare('DELETE FROM messages WHERE id = ?');
    for (const r of rows) del.run(r.id);
    db.prepare('INSERT INTO redactions (qq_id, group_id, removed_count, created_at) VALUES (?,?,?,?)')
      .run(qqId, groupId, rows.length, now());
    return { removed: rows.length, sessionIds };
  }
  function listRedactions(limit = 100) {
    return db.prepare('SELECT * FROM redactions ORDER BY id DESC LIMIT ?').all(limit);
  }
  function getSnippetBySession(sessionId) {
    return db.prepare('SELECT * FROM snippets WHERE session_id = ?').get(sessionId);
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
  function indexDeleteByRef(owner, kind, refId) {
    db.prepare('DELETE FROM search_index WHERE owner = ? AND kind = ? AND ref_id = ?').run(owner, kind, String(refId));
  }
  // 撤回发言后重建该片段的索引：删掉旧条目，按剩余发言重新入库
  function reindexSnippet(sessionId) {
    const sn = db.prepare('SELECT * FROM snippets WHERE session_id = ?').get(sessionId);
    if (!sn) return null;
    indexDeleteByRef(sn.qq_id, 'snippet', sn.id);
    indexDeleteByRef(sn.qq_id, 'summary', sn.id);
    const msgs = getMessages(sessionId);
    const transcript = msgs.map((m) => `${m.name}(${m.qq_id}) ${m.content}`).join('\n\n');
    if (transcript) indexAdd(transcript, sn.qq_id, 'snippet', sn.id);
    if (sn.summary) indexAdd(sn.summary, sn.qq_id, 'summary', sn.id);
    return { snippetId: sn.id, messageCount: msgs.length };
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
  // 片段与资料按"最早未推送时间"统一排序取一条。
  // 早期实现是"片段优先"，会导致有片段积压时资料永远轮不到（设计文档 §12 待细化项）。
  function pickBoomerangCandidate(qqId, cutoff) {
    const row = db.prepare(
      `SELECT * FROM (
         SELECT 'snippet' AS kind, id, summary AS label, created_at FROM snippets
           WHERE qq_id = ? AND created_at <= ? AND (last_sent IS NULL OR last_sent <= ?)
         UNION ALL
         SELECT 'file' AS kind, id, filename AS label, uploaded_at AS created_at FROM files
           WHERE qq_id = ? AND uploaded_at <= ? AND (last_sent IS NULL OR last_sent <= ?)
       ) ORDER BY created_at ASC LIMIT 1`
    ).get(qqId, cutoff, cutoff, qqId, cutoff, cutoff);
    if (!row) return null;
    return { kind: row.kind, id: row.id, summary: row.label, created_at: row.created_at };
  }
  // 回旋镖发送历史（boomerangs 表）
  function addBoomerangRecord(qqId, targetId, targetType) {
    db.prepare('INSERT INTO boomerangs (qq_id, target_id, target_type, scheduled_at, sent) VALUES (?,?,?,?,1)')
      .run(qqId, targetId, targetType, now());
  }
  function listBoomerangHistory({ qqId = null, limit = 100 } = {}) {
    const sql = `SELECT b.*, u.display_name FROM boomerangs b
      LEFT JOIN users u ON u.qq_id = b.qq_id
      ${qqId ? 'WHERE b.qq_id = ?' : ''} ORDER BY b.id DESC LIMIT ?`;
    return qqId
      ? db.prepare(sql).all(qqId, limit)
      : db.prepare(sql).all(limit);
  }
  function countBoomerangSent() {
    return db.prepare('SELECT COUNT(*) AS c FROM boomerangs WHERE sent = 1').get().c;
  }

  // ---- 统计 ----
  function stats(qqId) {
    const snippets = db.prepare('SELECT COUNT(*) AS c FROM snippets WHERE qq_id = ?').get(qqId).c;
    const files = db.prepare('SELECT COUNT(*) AS c FROM files WHERE qq_id = ?').get(qqId).c;
    const last = db.prepare('SELECT created_at FROM snippets WHERE qq_id = ? ORDER BY created_at DESC LIMIT 1').get(qqId);
    return { snippets, files, lastCreatedAt: last ? last.created_at : null };
  }

  // ==================================================================
  // 以下为管理台（web admin）专用
  // ==================================================================

  // ---- 会话 ----
  const SESSION_SELECT = `SELECT s.*, u.display_name,
      (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id) AS message_count,
      (SELECT COUNT(*) FROM snippets p WHERE p.session_id = s.id) AS snippet_count
    FROM sessions s LEFT JOIN users u ON u.qq_id = s.qq_id`;

  function listSessions({ status = null, qqId = null, limit = 200 } = {}) {
    const where = [];
    const args = [];
    if (status) {
      where.push('s.status = ?');
      args.push(status);
    }
    if (qqId) {
      where.push('s.qq_id = ?');
      args.push(qqId);
    }
    const sql = `${SESSION_SELECT}${where.length ? ' WHERE ' + where.join(' AND ') : ''} ORDER BY s.id DESC LIMIT ?`;
    args.push(limit);
    return db.prepare(sql).all(...args);
  }

  function getSession(id) {
    return db.prepare(`${SESSION_SELECT} WHERE s.id = ?`).get(id);
  }

  function countSessions() {
    return db.prepare('SELECT COUNT(*) AS c FROM sessions').get().c;
  }

  // ---- 片段 ----
  const SNIPPET_SELECT = `SELECT p.id, p.session_id, p.qq_id, p.created_at, p.last_sent,
      LENGTH(COALESCE(p.summary, '')) AS summary_len,
      SUBSTR(COALESCE(p.summary, ''), 1, 120) AS summary_head,
      u.display_name,
      (SELECT COUNT(*) FROM messages m WHERE m.session_id = p.session_id) AS message_count,
      (SELECT s.group_id FROM sessions s WHERE s.id = p.session_id) AS group_id
    FROM snippets p LEFT JOIN users u ON u.qq_id = p.qq_id`;

  function listSnippetsAdmin({ qqId = null, limit = 200, offset = 0 } = {}) {
    if (qqId) {
      return db.prepare(`${SNIPPET_SELECT} WHERE p.qq_id = ? ORDER BY p.id DESC LIMIT ? OFFSET ?`).all(qqId, limit, offset);
    }
    return db.prepare(`${SNIPPET_SELECT} ORDER BY p.id DESC LIMIT ? OFFSET ?`).all(limit, offset);
  }

  function getSnippet(id) {
    const row = db.prepare('SELECT * FROM snippets WHERE id = ?').get(id);
    if (!row) return null;
    const session = row.session_id ? getSession(row.session_id) : null;
    return Object.assign({}, row, {
      display_name: session ? session.display_name : null,
      group_id: session ? session.group_id : null,
      messages: row.session_id ? getMessages(row.session_id) : [],
    });
  }

  function updateSnippetSummary(id, summary) {
    db.prepare('UPDATE snippets SET summary = ? WHERE id = ?').run(summary || null, id);
  }

  function deleteSnippet(id) {
    const row = db.prepare('SELECT id FROM snippets WHERE id = ?').get(id);
    if (!row) return false;
    db.prepare('DELETE FROM search_index WHERE kind = ? AND ref_id = ?').run('snippet', String(id));
    db.prepare('DELETE FROM snippets WHERE id = ?').run(id);
    return true;
  }

  // ---- 资料 ----
  // 列表刻意不查 content_text（可能很大），只取字数
  const FILE_SELECT = `SELECT f.id, f.qq_id, f.filename, f.path, f.summary, f.uploaded_at, f.last_sent,
      LENGTH(COALESCE(f.content_text, '')) AS chars, u.display_name
    FROM files f LEFT JOIN users u ON u.qq_id = f.qq_id`;

  function listFilesAdmin({ qqId = null, limit = 200, offset = 0 } = {}) {
    if (qqId) {
      return db.prepare(`${FILE_SELECT} WHERE f.qq_id = ? ORDER BY f.id DESC LIMIT ? OFFSET ?`).all(qqId, limit, offset);
    }
    return db.prepare(`${FILE_SELECT} ORDER BY f.id DESC LIMIT ? OFFSET ?`).all(limit, offset);
  }

  function getFile(id) {
    return db.prepare('SELECT * FROM files WHERE id = ?').get(id);
  }

  function deleteFile(id) {
    const row = db.prepare('SELECT id, path FROM files WHERE id = ?').get(id);
    if (!row) return null;
    db.prepare('DELETE FROM search_index WHERE kind = ? AND ref_id = ?').run('file', String(id));
    db.prepare('DELETE FROM files WHERE id = ?').run(id);
    return row;
  }

  // ---- 用户（管理台视角：带统计） ----
  function listUsersAdmin() {
    return db.prepare(`SELECT u.*,
        (SELECT COUNT(*) FROM snippets p WHERE p.qq_id = u.qq_id) AS snippet_count,
        (SELECT COUNT(*) FROM files f WHERE f.qq_id = u.qq_id) AS file_count,
        (SELECT COUNT(*) FROM sessions s WHERE s.qq_id = u.qq_id) AS session_count,
        (SELECT COUNT(*) FROM sessions s WHERE s.qq_id = u.qq_id AND s.status = 'open') AS open_count,
        (SELECT MAX(created_at) FROM snippets p WHERE p.qq_id = u.qq_id) AS last_snippet_at
      FROM users u ORDER BY u.created_at ASC`).all();
  }

  function updateUser(qqId, fields) {
    const keys = Object.keys(fields || {}).filter((k) => USER_FIELDS.has(k));
    if (!keys.length) return false;
    const sets = keys.map((k) => `${k} = ?`).join(', ');
    db.prepare(`UPDATE users SET ${sets} WHERE qq_id = ?`).run(...keys.map((k) => fields[k]), qqId);
    return true;
  }

  // 级联删除某用户的全部数据（产品原则：数据归属用户本人，用户可要求删除）
  function deleteUser(qqId) {
    const sessions = db.prepare('SELECT id FROM sessions WHERE qq_id = ?').all(qqId).map((r) => r.id);
    const snippetIds = db.prepare('SELECT id FROM snippets WHERE qq_id = ?').all(qqId).map((r) => r.id);
    const fileIds = db.prepare('SELECT id FROM files WHERE qq_id = ?').all(qqId).map((r) => r.id);

    db.exec('BEGIN');
    try {
      for (const sid of sessions) {
        for (const s of db.prepare('SELECT id FROM snippets WHERE session_id = ?').all(sid)) {
          db.prepare('DELETE FROM search_index WHERE kind = ? AND ref_id = ?').run('snippet', String(s.id));
        }
        db.prepare('DELETE FROM snippets WHERE session_id = ?').run(sid);
        db.prepare('DELETE FROM messages WHERE session_id = ?').run(sid);
      }
      for (const id of snippetIds) db.prepare('DELETE FROM search_index WHERE kind = ? AND ref_id = ?').run('snippet', String(id));
      for (const id of fileIds) db.prepare('DELETE FROM search_index WHERE kind = ? AND ref_id = ?').run('file', String(id));
      db.prepare('DELETE FROM search_index WHERE owner = ?').run(qqId);
      db.prepare('DELETE FROM sessions WHERE qq_id = ?').run(qqId);
      db.prepare('DELETE FROM snippets WHERE qq_id = ?').run(qqId);
      db.prepare('DELETE FROM files WHERE qq_id = ?').run(qqId);
      db.prepare('DELETE FROM boomerangs WHERE qq_id = ?').run(qqId);
      db.prepare('DELETE FROM users WHERE qq_id = ?').run(qqId);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    return { sessions: sessions.length, snippets: snippetIds.length, files: fileIds.length };
  }

  // ---- 全局检索（跨所有用户） ----
  function searchAll(kw, limit = 50) {
    const clean = String(kw).replace(/["'()*:^\[\]]/g, ' ').trim();
    if (!clean) return [];
    const cols = `search_index.owner, search_index.kind, search_index.ref_id, search_index.content, u.display_name`;
    const from = `FROM search_index LEFT JOIN users u ON u.qq_id = search_index.owner`;
    if (clean.length >= 3) {
      try {
        return db.prepare(`SELECT ${cols} ${from} WHERE search_index MATCH ? LIMIT ?`).all(clean, limit);
      } catch (e) {
        // 落到 LIKE
      }
    }
    return db.prepare(`SELECT ${cols} ${from} WHERE search_index.content LIKE ? LIMIT ?`).all(`%${clean}%`, limit);
  }

  // ---- 总览 ----
  function overview() {
    const c = (sql, ...a) => db.prepare(sql).get(...a).c;
    const max = (sql) => {
      const r = db.prepare(sql).get();
      return r ? r.t : null;
    };
    return {
      users: c('SELECT COUNT(*) AS c FROM users'),
      sessions: c('SELECT COUNT(*) AS c FROM sessions'),
      openSessions: c("SELECT COUNT(*) AS c FROM sessions WHERE status = 'open'"),
      messages: c('SELECT COUNT(*) AS c FROM messages'),
      snippets: c('SELECT COUNT(*) AS c FROM snippets'),
      summarized: c('SELECT COUNT(*) AS c FROM snippets WHERE summary IS NOT NULL'),
      files: c('SELECT COUNT(*) AS c FROM files'),
      indexRows: c('SELECT COUNT(*) AS c FROM search_index'),
      lastMessageAt: max('SELECT MAX(ts) AS t FROM messages'),
      lastSnippetAt: max('SELECT MAX(created_at) AS t FROM snippets'),
      lastUploadAt: max('SELECT MAX(uploaded_at) AS t FROM files'),
      recentSnippets: db.prepare(
        `SELECT p.id, p.qq_id, p.created_at, u.display_name,
                substr(COALESCE(p.summary, ''), 1, 80) AS summary_head
         FROM snippets p
         LEFT JOIN users u ON u.qq_id = p.qq_id ORDER BY p.id DESC LIMIT 8`
      ).all(),
      recentFiles: db.prepare(
        `SELECT f.id, f.qq_id, f.filename, f.uploaded_at, u.display_name FROM files f
         LEFT JOIN users u ON u.qq_id = f.qq_id ORDER BY f.id DESC LIMIT 8`
      ).all(),
      groups: db.prepare(
        `SELECT group_id, COUNT(*) AS session_count, MAX(start_time) AS last_active
         FROM sessions WHERE group_id IS NOT NULL GROUP BY group_id ORDER BY last_active DESC LIMIT 20`
      ).all(),
    };
  }

  // ---- 回旋镖队列预览 ----
  // pickBoomerangCandidate 每轮只给一个（调度用）；管理台要看到完整积压，所以单独列全部
  function listBoomerangCandidates(qqId, cutoff, limit = 50) {
    const snippets = db.prepare(
      `SELECT id, summary, created_at, 'snippet' AS kind FROM snippets
       WHERE qq_id = ? AND created_at <= ? AND (last_sent IS NULL OR last_sent <= ?)
       ORDER BY created_at ASC LIMIT ?`
    ).all(qqId, cutoff, cutoff, limit);
    const files = db.prepare(
      `SELECT id, filename AS summary, uploaded_at AS created_at, 'file' AS kind FROM files
       WHERE qq_id = ? AND uploaded_at <= ? AND (last_sent IS NULL OR last_sent <= ?)
       ORDER BY uploaded_at ASC LIMIT ?`
    ).all(qqId, cutoff, cutoff, limit);
    return snippets.concat(files).sort((a, b) => a.created_at - b.created_at).slice(0, limit);
  }

  function boomerangQueue(daysOf) {
    const now = Date.now();
    const out = [];
    for (const u of listUsers()) {
      const days = daysOf ? daysOf(u) : u.boomerang_days || 3;
      for (const cand of listBoomerangCandidates(u.qq_id, now - days * 86400000)) {
        out.push({
          qq_id: u.qq_id,
          display_name: u.display_name,
          days,
          kind: cand.kind,
          id: cand.id,
          created_at: cand.created_at,
          title: cand.summary,
          dueAt: cand.created_at + days * 86400000,
        });
      }
    }
    return out.sort((a, b) => a.dueAt - b.dueAt);
  }

  return {
    // 运行时
    upsertUser, getUser, listUsers, setUserSetting, storageChars,
    hasGroupNotice, markGroupNotice, clearGroupNotice,
    createSession, getOpenSession, getOpenSessionsByGroup, archiveSession,
    addMessage, getMessages, deleteMessagesByUserInGroup, getSnippetBySession,
    createSnippet, listSnippets, setSnippetSent,
    addFile, listFiles, setFileSent,
    indexAdd, indexDeleteByRef, reindexSnippet, search,
    pickBoomerangCandidate, addBoomerangRecord, listBoomerangHistory, countBoomerangSent, stats,
    // 管理台
    listSessions, getSession, countSessions,
    listSnippetsAdmin, getSnippet, updateSnippetSummary, deleteSnippet,
    listFilesAdmin, getFile, deleteFile,
    listUsersAdmin, updateUser, deleteUser, listRedactions,
    searchAll, overview, boomerangQueue, listBoomerangCandidates,
  };
}

module.exports = { createRepo };
