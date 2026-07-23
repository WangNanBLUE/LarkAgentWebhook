import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { PendingAction } from "../types.js";

type ClaimResult = { ok: true; action: PendingAction } | { ok: false; reason: "not_found" | "expired" };

export class StateStore {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS processed_messages (
        message_id TEXT PRIMARY KEY,
        processed_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS pending_actions (
        id TEXT PRIMARY KEY,
        requester_id TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        root_message_id TEXT NOT NULL,
        thread_id TEXT,
        expires_at INTEGER NOT NULL,
        kind TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        result_json TEXT,
        error_message TEXT,
        reconciliation_json TEXT,
        created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
      );
      CREATE INDEX IF NOT EXISTS pending_lookup ON pending_actions(requester_id, chat_id, thread_id, status, created_at);
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS managed_components (
        block_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        config_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    this.ensureColumn("pending_actions", "result_json", "TEXT");
    this.ensureColumn("pending_actions", "error_message", "TEXT");
    this.ensureColumn("pending_actions", "reconciliation_json", "TEXT");
  }

  markMessageProcessed(messageId: string, now = Date.now()): boolean {
    const result = this.db.prepare("INSERT OR IGNORE INTO processed_messages(message_id, processed_at) VALUES (?, ?)").run(messageId, now);
    return result.changes === 1;
  }

  createPendingAction(action: PendingAction): void {
    this.db.prepare(`
      INSERT INTO pending_actions(id, requester_id, chat_id, root_message_id, thread_id, expires_at, kind, payload_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(action.id, action.requesterId, action.chatId, action.rootMessageId, action.threadId ?? null, action.expiresAt, action.kind, JSON.stringify(action.payload));
  }

  claimPendingAction(requesterId: string, chatId: string, now = Date.now()): ClaimResult {
    return this.claimPendingWhere("requester_id = ? AND chat_id = ?", [requesterId, chatId], now, "executing");
  }

  claimPendingActionById(id: string, requesterId: string, chatId: string, now = Date.now()): ClaimResult {
    return this.claimPendingWhere("id = ? AND requester_id = ? AND chat_id = ?", [id, requesterId, chatId], now, "executing");
  }

  cancelPendingActionById(id: string, requesterId: string, chatId: string, now = Date.now()): ClaimResult {
    return this.claimPendingWhere("id = ? AND requester_id = ? AND chat_id = ?", [id, requesterId, chatId], now, "cancelled");
  }

  private claimPendingWhere(where: string, params: string[], now: number, nextStatus: "executing" | "cancelled"): ClaimResult {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db.prepare(`
        SELECT * FROM pending_actions
        WHERE ${where} AND status = 'pending'
        ORDER BY created_at DESC LIMIT 1
      `).get(...params) as Record<string, unknown> | undefined;
      if (!row) {
        this.db.exec("COMMIT");
        return { ok: false, reason: "not_found" };
      }
      if (Number(row.expires_at) < now) {
        this.db.prepare("UPDATE pending_actions SET status = 'expired' WHERE id = ?").run(String(row.id));
        this.db.exec("COMMIT");
        return { ok: false, reason: "expired" };
      }
      this.db.prepare("UPDATE pending_actions SET status = ? WHERE id = ? AND status = 'pending'").run(nextStatus, String(row.id));
      this.db.exec("COMMIT");
      return {
        ok: true,
        action: {
          id: String(row.id), requesterId: String(row.requester_id), chatId: String(row.chat_id),
          rootMessageId: String(row.root_message_id), threadId: row.thread_id ? String(row.thread_id) : undefined,
          expiresAt: Number(row.expires_at), kind: String(row.kind) as PendingAction["kind"], payload: JSON.parse(String(row.payload_json)),
        },
      };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  markActionCompleted(id: string, result: unknown): void {
    this.db.prepare("UPDATE pending_actions SET status = 'completed', result_json = ?, error_message = NULL WHERE id = ? AND status = 'executing'")
      .run(JSON.stringify(result), id);
  }

  markActionUnknown(id: string, message: string): void {
    this.db.prepare("UPDATE pending_actions SET status = 'unknown', error_message = ? WHERE id = ? AND status = 'executing'")
      .run(message.slice(0, 1000), id);
  }

  setActionReconciliation(id: string, value: unknown): void {
    this.db.prepare("UPDATE pending_actions SET reconciliation_json = ? WHERE id = ? AND status = 'executing'").run(JSON.stringify(value), id);
  }

  listExecutingActions(): Array<{ action: PendingAction; reconciliation?: unknown }> {
    const rows = this.db.prepare("SELECT * FROM pending_actions WHERE status = 'executing' ORDER BY created_at").all() as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      action: toPendingAction(row),
      reconciliation: row.reconciliation_json ? JSON.parse(String(row.reconciliation_json)) : undefined,
    }));
  }

  getPendingActionStatus(id: string): string | undefined {
    const row = this.db.prepare("SELECT status FROM pending_actions WHERE id = ?").get(id) as { status: string } | undefined;
    return row?.status;
  }

  getSetting(key: string): string | undefined {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
    return row?.value;
  }

  setSetting(key: string, value: string): void {
    this.db.prepare("INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, value);
  }

  registerComponent(blockId: string, name: string, type: string, config: unknown): void {
    this.db.prepare(`INSERT INTO managed_components(block_id,name,type,config_json,updated_at) VALUES(?,?,?,?,?)
      ON CONFLICT(block_id) DO UPDATE SET name=excluded.name,type=excluded.type,config_json=excluded.config_json,updated_at=excluded.updated_at`)
      .run(blockId, name, type, JSON.stringify(config), Date.now());
  }

  isManagedComponent(blockId: string): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM managed_components WHERE block_id = ?").get(blockId));
  }

  getManagedComponentRecord(blockId: string): { blockId: string; name: string; type: string; config: Record<string, unknown> } | undefined {
    const row = this.db.prepare("SELECT block_id, name, type, config_json FROM managed_components WHERE block_id = ?").get(blockId) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return { blockId: String(row.block_id), name: String(row.name), type: String(row.type), config: JSON.parse(String(row.config_json)) as Record<string, unknown> };
  }

  listManagedComponents(): unknown[] {
    return this.db.prepare("SELECT block_id, name, type, config_json, updated_at FROM managed_components ORDER BY updated_at DESC").all();
  }

  close(): void { this.db.close(); }

  private ensureColumn(table: string, column: string, definition: string): void {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!columns.some((item) => item.name === column)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

function toPendingAction(row: Record<string, unknown>): PendingAction {
  return {
    id: String(row.id), requesterId: String(row.requester_id), chatId: String(row.chat_id),
    rootMessageId: String(row.root_message_id), threadId: row.thread_id ? String(row.thread_id) : undefined,
    expiresAt: Number(row.expires_at), kind: String(row.kind) as PendingAction["kind"], payload: JSON.parse(String(row.payload_json)),
  };
}
