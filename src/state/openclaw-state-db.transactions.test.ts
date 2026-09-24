import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "./openclaw-state-db.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(() => {
    closeOpenClawStateDatabaseForTest();
    cleanup();
  }),
);

it("refuses a savepoint in an unmanaged enclosing transaction", () => {
  const options = {
    path: path.join(tempDirs.make("state-unmanaged-transaction-"), "state.sqlite"),
  };
  const database = openOpenClawStateDatabase(options);
  const callback = vi.fn();
  database.db.exec("BEGIN IMMEDIATE");
  try {
    expect(() => runOpenClawStateWriteTransaction(callback, { ...options, database })).toThrow(
      /unmanaged.*transaction/i,
    );
    expect(callback).not.toHaveBeenCalled();
    expect(database.db.isTransaction).toBe(true);
  } finally {
    database.db.exec("ROLLBACK");
  }
});

it.each(["cached", "supplied"] as const)(
  "lets SQLite exclude a competing %s writer and resumes after its commit",
  (handle) => {
    const options = { path: path.join(tempDirs.make("state-native-contention-"), "state.sqlite") };
    const database = openOpenClawStateDatabase(options);
    const writeOptions = handle === "supplied" ? { ...options, database } : options;
    const other = new DatabaseSync(database.path);
    const write = vi.fn(() => {
      database.db
        .prepare(
          "INSERT INTO diagnostic_events(scope,event_key,payload_json,created_at) VALUES(?,?,?,?)",
        )
        .run("native-transaction", "committed", "{}", 1);
    });
    try {
      other.exec("BEGIN IMMEDIATE");
      expect(() =>
        runOpenClawStateWriteTransaction(write, writeOptions, { busyTimeoutMs: 0 }),
      ).toThrow(/locked|busy/i);
      expect(write).not.toHaveBeenCalled();
      expect(database.db.isTransaction).toBe(false);
      other.exec("COMMIT");
      runOpenClawStateWriteTransaction(write, writeOptions, { busyTimeoutMs: 0 });
      expect(write).toHaveBeenCalledOnce();
      expect(
        other
          .prepare("SELECT event_key FROM diagnostic_events WHERE scope=?")
          .all("native-transaction"),
      ).toEqual([{ event_key: "committed" }]);
    } finally {
      if (other.isTransaction) {
        other.exec("ROLLBACK");
      }
      other.close();
    }
  },
);
