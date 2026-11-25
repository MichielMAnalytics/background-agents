import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyMigrations } from "../node/migrate";
import { createNodeSqlDatabase, type NodeSqlDatabase } from "../node/sqlite-database";
import { AutomationStore } from "./automation-store";
import type { SqlDatabase } from "./sql-database";

let db: NodeSqlDatabase;

beforeEach(() => {
  const sqlite = new DatabaseSync(":memory:");
  applyMigrations(
    sqlite,
    resolve(dirname(fileURLToPath(import.meta.url)), "../../../../terraform/d1/migrations")
  );
  db = createNodeSqlDatabase(sqlite);
});

afterEach(() => db.close());

/** Run `query` against a store and return the plan of the first statement it binds. */
async function planOfFirstQuery(query: (store: AutomationStore) => Promise<unknown>) {
  const captured: Array<{ sql: string; values: unknown[] }> = [];
  const measured: SqlDatabase = {
    prepare(sql) {
      const statement = db.prepare(sql);
      return {
        ...statement,
        bind(...values) {
          captured.push({ sql, values });
          return statement.bind(...values);
        },
      };
    },
    batch: (statements) => db.batch(statements),
  };

  await query(new AutomationStore(measured));

  const [first] = captured;
  const plan = await db
    .prepare(`EXPLAIN QUERY PLAN ${first!.sql}`)
    .bind(...first!.values)
    .all<{ detail: string }>();
  return plan.results.map(({ detail }) => detail);
}

describe("AutomationStore query plan", () => {
  it("counts firings by actor kind through the partial actor index", async () => {
    const plan = await planOfFirstQuery((store) =>
      store.countFiringsSince("auto-1", { actorKind: "bot", since: 0, limit: 10 })
    );
    expect(plan).toContainEqual(expect.stringContaining("idx_invocations_actor_created"));
  });

  it("counts an automation's firings in flight through the partial active-run index", async () => {
    const plan = await planOfFirstQuery((store) => store.isAtConcurrencyLimit("auto-1"));
    expect(plan).toContainEqual(expect.stringContaining("idx_runs_active_lookup"));
  });
});
