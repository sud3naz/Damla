import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export function openDb(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
  const db = new DatabaseSync(path)
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS plans (
      id TEXT PRIMARY KEY,
      network TEXT NOT NULL,
      user TEXT NOT NULL,
      channel TEXT NOT NULL,
      channel_secret TEXT,
      cancel_hash TEXT NOT NULL,
      amount TEXT NOT NULL,
      period TEXT NOT NULL,
      period_seconds INTEGER NOT NULL,
      count INTEGER NOT NULL,
      ceiling INTEGER NOT NULL,
      quote_xlm TEXT NOT NULL,
      start_seq TEXT NOT NULL,
      t0 INTEGER NOT NULL,
      status TEXT NOT NULL,
      note TEXT,
      created_at INTEGER NOT NULL,
      finalized_at INTEGER,
      ended_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS plans_user ON plans(user);
    CREATE INDEX IF NOT EXISTS plans_status ON plans(status);
    CREATE TABLE IF NOT EXISTS txs (
      plan_id TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
      idx INTEGER NOT NULL,
      kind TEXT NOT NULL,
      hash TEXT NOT NULL,
      seq TEXT NOT NULL,
      min_time INTEGER NOT NULL,
      max_time INTEGER NOT NULL,
      min_seq_age INTEGER NOT NULL,
      dest_min TEXT,
      xdr TEXT NOT NULL,
      signed INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL,
      note TEXT,
      result_code TEXT,
      ledger INTEGER,
      received_xlm TEXT,
      executed_at INTEGER,
      attempts INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (plan_id, idx)
    );
  `)
  return db
}

export function rowPlan(db, id) {
  return db.prepare('SELECT * FROM plans WHERE id = ?').get(id) || null
}

export function rowTxs(db, planId) {
  return db.prepare('SELECT * FROM txs WHERE plan_id = ? ORDER BY idx').all(planId)
}
