// Keep the OAuth source-lock fixture separate from the private-handle retirement matrix.
import { expect, vi } from "vitest";
import { operatorMcpOAuthIdentity } from "../agents/mcp-oauth-identity.js";
import { resolveMcpOAuthAccessToken } from "../agents/mcp-oauth.js";
import type { HealthCheck } from "../flows/health-checks.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import type { RuntimeEnv } from "../runtime.js";
import { closeOpenClawStateDatabaseByPathAsync } from "../state/openclaw-state-db-cache.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { runDoctorLintCli } from "./doctor-lint.js";
import {
  seedDoctorLintMcpToken,
  snapshotDoctorLintSqliteFamily,
} from "./doctor-lint.test-support.js";

export async function verifyDoctorLintOAuthStateIsolation(
  runtime: RuntimeEnv,
  installHealthChecks: (checks: HealthCheck[]) => void,
): Promise<void> {
  await withOpenClawTestState({ prefix: "doctor-lint-oauth-" }, async (state) => {
    await state.writeConfig({});
    const identity = operatorMcpOAuthIdentity("oauth-proof", "https://mcp.example.test/rpc");
    await seedDoctorLintMcpToken(identity);
    const databasePath = resolveOpenClawStateSqlitePath(state.env);
    await closeOpenClawStateDatabaseByPathAsync(databasePath);
    const lock = openNodeSqliteDatabase(databasePath);
    try {
      // Materialize the caller's WAL sidecars before measuring Doctor's effects.
      // Windows byte-range locks prohibit raw snapshots during the transaction.
      lock.exec("BEGIN IMMEDIATE; ROLLBACK");
      const before = snapshotDoctorLintSqliteFamily(databasePath);
      lock.exec("BEGIN IMMEDIATE");
      let resolvedToken: string | undefined;
      installHealthChecks([
        {
          id: "core/doctor/runtime-tool-schemas",
          kind: "core",
          description: "checks OAuth state ownership",
          async detect() {
            resolvedToken = await resolveMcpOAuthAccessToken({
              identity,
              acceptUnknownExpiry: true,
              signal: AbortSignal.timeout(250),
            });
            return [];
          },
        },
      ]);
      const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      try {
        await expect(
          runDoctorLintCli(runtime, {
            json: true,
            onlyIds: ["core/doctor/runtime-tool-schemas"],
          }),
        ).resolves.toBe(0);
        const report = JSON.parse(String(stdout.mock.calls.at(-1)?.[0]));
        expect(report).toMatchObject({
          ok: true,
          checksRun: 1,
          findings: [],
        });
        expect(report.warnings ?? []).toEqual([]);
        expect(resolvedToken).toBe("stored-inspection-token-not-real");
        expect(lock.isOpen).toBe(true);
        expect(lock.isTransaction).toBe(true);
        lock.exec("ROLLBACK");
        expect(snapshotDoctorLintSqliteFamily(databasePath)).toEqual(before);
      } finally {
        stdout.mockRestore();
      }
    } finally {
      if (lock.isTransaction) {
        lock.exec("ROLLBACK");
      }
      lock.close();
      await closeOpenClawStateDatabaseByPathAsync(databasePath);
    }
  });
}
