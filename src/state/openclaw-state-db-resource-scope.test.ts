import { expect, it, vi } from "vitest";
import { createOpenClawDatabaseMaintenanceScope } from "./openclaw-state-db-async-lifecycle.js";

it("keeps resource custody unprivileged and preserves inherited owner validity", async () => {
  const runtime = createOpenClawDatabaseMaintenanceScope();
  const nestedRuntime = runtime.run(() => createOpenClawDatabaseMaintenanceScope());
  expect(runtime.ownsSchemaMaintenance).toBe(false);
  expect(nestedRuntime.ownsSchemaMaintenance).toBe(false);
  await nestedRuntime.close();
  await runtime.close();

  let current = true;
  const lost = new Error("Maintenance owner is no longer current");
  const assertOwnerCurrent = vi.fn(() => {
    if (!current) {
      throw lost;
    }
  });
  const maintenance = createOpenClawDatabaseMaintenanceScope({ assertOwnerCurrent });
  const nested = maintenance.run(() => createOpenClawDatabaseMaintenanceScope());
  expect(nested.ownsSchemaMaintenance).toBe(false);
  nested.assertAdmission();
  expect(assertOwnerCurrent).toHaveBeenCalled();
  current = false;
  expect(() => nested.assertAdmission()).toThrow(lost);
  current = true;
  await maintenance.close();
  expect(() => nested.assertAdmission()).toThrow("Database maintenance resource scope is closed");
  await nested.close();
});
