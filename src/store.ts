import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { now, type Tables, type Base } from "./domain.js";
const names = [
  "projects",
  "repositories",
  "tasks",
  "groups",
  "runs",
  "evidence",
  "deliveries",
  "events",
  "outbox",
  "skills",
  "inbox",
] as const;
export class Store {
  db: DatabaseSync;
  constructor(public file: string) {
    mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;");
    for (const name of names)
      this.db.exec(
        `CREATE TABLE IF NOT EXISTS ${name} (id TEXT PRIMARY KEY, data TEXT NOT NULL CHECK(json_valid(data)));`,
      );
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS group_status ON groups(json_extract(data,'$.status')); CREATE INDEX IF NOT EXISTS event_task ON events(json_extract(data,'$.taskId')); CREATE TABLE IF NOT EXISTS settings (id TEXT PRIMARY KEY, value TEXT NOT NULL);",
    );
  }
  all<K extends keyof Tables>(table: K): Tables[K][] {
    return this.db
      .prepare(`SELECT data FROM ${table} ORDER BY rowid`)
      .all()
      .map((r) => JSON.parse(String(r.data)));
  }
  get<K extends keyof Tables>(table: K, id: string): Tables[K] {
    const r = this.db.prepare(`SELECT data FROM ${table} WHERE id=?`).get(id);
    if (!r) throw new Error(`${table}: ${id} 不存在`);
    return JSON.parse(String(r.data));
  }
  maybe<K extends keyof Tables>(table: K, id: string): Tables[K] | undefined {
    try {
      return this.get(table, id);
    } catch {
      return undefined;
    }
  }
  put<K extends keyof Tables>(table: K, value: Tables[K]): Tables[K] {
    this.db
      .prepare(
        `INSERT INTO ${table}(id,data) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data`,
      )
      .run(value.id, JSON.stringify(value));
    return value;
  }
  create<K extends keyof Tables>(
    table: K,
    value: Omit<Tables[K], keyof Base>,
    id?: string,
  ): Tables[K] {
    const date = now();
    return this.put(table, {
      ...value,
      id:
        id ??
        `${table === "tasks" ? "T" : table.slice(0, 2).toUpperCase()}-${randomUUID().slice(0, 8)}`,
      createdAt: date,
      updatedAt: date,
    } as Tables[K]);
  }
  patch<K extends keyof Tables>(
    table: K,
    id: string,
    patch: Partial<Tables[K]>,
  ): Tables[K] {
    return this.put(table, {
      ...this.get(table, id),
      ...patch,
      id,
      updatedAt: now(),
    });
  }
  transaction<T>(fn: () => T): T {
    // 业务动作外层事务需要同时提交状态与幂等回执；内层沿用同一事务。
    if (this.db.isTransaction) return fn();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const out = fn();
      this.db.exec("COMMIT");
      return out;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  claim(id: string): boolean {
    // 认领和状态改变在同一条 SQL 中，事件重复唤醒也不能启动两次。
    return (
      this.db
        .prepare(
          "UPDATE groups SET data=json_set(data,'$.status','running','$.updatedAt',?) WHERE id=? AND json_extract(data,'$.status')='queued'",
        )
        .run(now(), id).changes === 1
    );
  }
  setting<T>(id: string, fallback: T): T {
    const r = this.db.prepare("SELECT value FROM settings WHERE id=?").get(id);
    return r ? JSON.parse(String(r.value)) : fallback;
  }
  setSetting(id: string, value: unknown) {
    this.db
      .prepare(
        "INSERT INTO settings VALUES(?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value",
      )
      .run(id, JSON.stringify(value));
  }
  close() {
    this.db.close();
  }
}
