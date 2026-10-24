import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

/** One local business ledger. Private files never belong in the release. */
export class Store {
  constructor(directory) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
    if (fs.lstatSync(directory).isSymbolicLink()) throw new Error('State directory cannot be a symbolic link')
    fs.chmodSync(directory, 0o700)
    this.directory = fs.realpathSync(directory)
    const file = path.join(this.directory, 'hub.sqlite')
    if (!fs.existsSync(file)) fs.closeSync(fs.openSync(file, 'wx', 0o600))
    if (!fs.lstatSync(file).isFile() || fs.lstatSync(file).isSymbolicLink()) throw new Error('Invalid state database')
    fs.chmodSync(file, 0o600)
    this.db = new DatabaseSync(file)
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000;
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS entities (kind TEXT NOT NULL,id TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(kind,id));
      CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT,body TEXT NOT NULL);
      INSERT OR IGNORE INTO meta VALUES ('version','1');`)
    if (this.db.prepare('SELECT value FROM meta WHERE key=?').get('version').value !== '1') throw new Error('Unsupported hub state version')
  }
  get(kind, id) { const row = this.db.prepare('SELECT body FROM entities WHERE kind=? AND id=?').get(kind, id); return row ? JSON.parse(row.body) : undefined }
  list(kind) { return this.db.prepare('SELECT body FROM entities WHERE kind=? ORDER BY rowid').all(kind).map(row => JSON.parse(row.body)) }
  put(kind, value) { this.db.prepare('INSERT INTO entities VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET body=excluded.body').run(kind, value.id, JSON.stringify(value)); return value }
  delete(kind,id) { this.db.prepare('DELETE FROM entities WHERE kind=? AND id=?').run(kind,id) }
  event(event) { const result = this.db.prepare('INSERT INTO events(body) VALUES(?)').run(JSON.stringify(event)); return { ...event, id: Number(result.lastInsertRowid) } }
  events(after = 0, limit = 1000) { return this.db.prepare('SELECT id,body FROM events WHERE id>? ORDER BY id LIMIT ?').all(after, limit).map(row => ({...JSON.parse(row.body), id:Number(row.id)})) }
  tx(fn) { this.db.exec('BEGIN IMMEDIATE'); try { const result = fn(); if (result?.then) throw new Error('Async work is not allowed inside ledger transactions'); this.db.exec('COMMIT'); return result } catch(error) { this.db.exec('ROLLBACK'); throw error } }
  close() { this.db.close() }
}
