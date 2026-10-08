'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  qq_id          TEXT PRIMARY KEY,
  display_name   TEXT,
  mode           TEXT DEFAULT 'hosted',
  boomerang_days INTEGER DEFAULT 3,
  summary_on     INTEGER DEFAULT 1,
  created_at     INTEGER
);

CREATE TABLE IF NOT EXISTS sessions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  qq_id       TEXT NOT NULL,
  group_id    TEXT,
  start_time  INTEGER,
  end_time    INTEGER,
  status      TEXT DEFAULT 'open'
);

CREATE TABLE IF NOT EXISTS messages (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  INTEGER NOT NULL,
  qq_id       TEXT,
  name        TEXT,
  content     TEXT,
  ts          INTEGER,
  is_recorder INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS snippets (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  INTEGER,
  qq_id       TEXT,
  summary     TEXT,
  created_at  INTEGER,
  last_sent   INTEGER
);

CREATE TABLE IF NOT EXISTS files (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  qq_id        TEXT,
  filename     TEXT,
  path         TEXT,
  content_text TEXT,
  summary      TEXT,
  uploaded_at  INTEGER,
  last_sent    INTEGER
);

CREATE TABLE IF NOT EXISTS boomerangs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  qq_id        TEXT,
  target_id    INTEGER,
  target_type  TEXT,
  scheduled_at INTEGER,
  sent         INTEGER DEFAULT 0
);

-- 群级"已告知"状态：首次在某群开启记录时发一次知情同意公告，之后不重复刷屏
CREATE TABLE IF NOT EXISTS group_notices (
  group_id     TEXT PRIMARY KEY,
  announced_at INTEGER
);

-- 撤回审计：用户行使"删除我在本群的发言"权利时留痕（实际数据是真删）
CREATE TABLE IF NOT EXISTS redactions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  qq_id         TEXT,
  group_id      TEXT,
  removed_count INTEGER,
  created_at    INTEGER
);

-- 全文检索：trigram 分词器支持中文子串匹配
CREATE VIRTUAL TABLE IF NOT EXISTS search_index USING fts5(
  content,
  owner UNINDEXED,
  kind UNINDEXED,
  ref_id UNINDEXED,
  tokenize='trigram'
);

CREATE INDEX IF NOT EXISTS idx_sessions_qq      ON sessions(qq_id, status);
CREATE INDEX IF NOT EXISTS idx_sessions_group   ON sessions(group_id, status);
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);
CREATE INDEX IF NOT EXISTS idx_messages_speaker ON messages(qq_id);
CREATE INDEX IF NOT EXISTS idx_snippets_qq      ON snippets(qq_id);
CREATE INDEX IF NOT EXISTS idx_files_qq         ON files(qq_id);
CREATE INDEX IF NOT EXISTS idx_boomerangs_qq    ON boomerangs(qq_id, id);
`;

function openDb(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  return db;
}

module.exports = { openDb, SCHEMA };
