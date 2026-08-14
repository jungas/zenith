/**
 * The server's persistence layer: one row holding the whole budget blob,
 * exactly like the localStorage model it replaces, plus an insert-only
 * history table as a safety net a browser never had.
 *
 * Why SQLite for what is still "one JSON blob": normalising accounts,
 * transactions, budgets etc. into real tables would mean rewriting every pure
 * function in `src/core/`, which all take and return a whole `AppState`. That
 * is a much bigger project than "run this on a server" calls for. SQLite here
 * buys crash-safe, atomic writes (via WAL mode and a transaction per save) and
 * a queryable history — durability, not a schema redesign.
 *
 * Concurrency is optimistic: every save carries the version it was read at,
 * and a save whose version has fallen behind is rejected with the current
 * version and data rather than silently overwritten. That is the one place a
 * server-backed budget can lose data that localStorage never could — two
 * tabs, or a phone and a desktop, saving at once — so it is guarded explicitly
 * instead of trusting last-write-wins.
 */

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/** Insert-only snapshots beyond this are trimmed on every write. */
const HISTORY_LIMIT = 200;

export interface StateRow {
  version: number;
  data: string;
}

export type SaveResult = { ok: true; version: number } | { ok: false; current: StateRow };

export class StateStore {
  #db: DatabaseSync;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.#db = new DatabaseSync(path);
    this.#db.exec('PRAGMA journal_mode = WAL');
    this.#db.exec('PRAGMA foreign_keys = ON');
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS app_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        data TEXT NOT NULL,
        version INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS app_state_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        version INTEGER NOT NULL,
        data TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  }

  /** Current row, or `null` if nothing has been saved yet. */
  read(): StateRow | null {
    const row = this.#db.prepare('SELECT data, version FROM app_state WHERE id = 1').get() as
      | { data: string; version: number }
      | undefined;
    return row ? { data: row.data, version: row.version } : null;
  }

  /**
   * Write `data` as the new state, but only if `expectedVersion` still
   * matches what is stored — the whole optimistic-concurrency check, done
   * inside one transaction so a concurrent writer can never interleave.
   */
  write(data: string, expectedVersion: number): SaveResult {
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.#db.prepare('SELECT data, version FROM app_state WHERE id = 1').get() as
        | { data: string; version: number }
        | undefined;
      const currentVersion = row?.version ?? 0;
      if (currentVersion !== expectedVersion) {
        this.#db.exec('ROLLBACK');
        return { ok: false, current: { data: row?.data ?? 'null', version: currentVersion } };
      }

      const nextVersion = currentVersion + 1;
      const now = new Date().toISOString();
      if (row) {
        this.#db
          .prepare('UPDATE app_state SET data = ?, version = ?, updated_at = ? WHERE id = 1')
          .run(data, nextVersion, now);
      } else {
        this.#db
          .prepare('INSERT INTO app_state (id, data, version, updated_at) VALUES (1, ?, ?, ?)')
          .run(data, nextVersion, now);
      }
      this.#db
        .prepare('INSERT INTO app_state_history (version, data, updated_at) VALUES (?, ?, ?)')
        .run(nextVersion, data, now);
      this.#db.exec(`
        DELETE FROM app_state_history
        WHERE id NOT IN (SELECT id FROM app_state_history ORDER BY id DESC LIMIT ${HISTORY_LIMIT})
      `);

      this.#db.exec('COMMIT');
      return { ok: true, version: nextVersion };
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
  }

  close(): void {
    this.#db.close();
  }
}
