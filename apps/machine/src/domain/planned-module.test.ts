import { describe, expect, it } from "vitest";

import { plannedMissingModule } from "./planned-module.ts";

// DISC-53's plan: a new lambda, a new export from the shared UI package.
const touchpoints = ["apps/lambdas/evaluation", "apps/lambdas/evaluation/src/app.ts", "apps/lambdas/evaluation/src/routes/forms.routes.ts", "packages/ui/package.json", "packages/ui/src/evaluation", "packages/domain/src/Evaluation/Evaluation.entity.ts"];

describe("plannedMissingModule: a red that fails only because the code the plan creates is not there yet", () => {
  it("takes a module the plan creates inside a planned folder (the new lambda's test harness)", () => {
    expect(plannedMissingModule("Error: Cannot find module 'apps/lambdas/evaluation/src/testing/setup.ts' (lambda missing)", touchpoints)).toBe("apps/lambdas/evaluation/src/testing/setup.ts");
  });

  it("takes a module named relative to the test that imports it (`/src/app` from the lambda's own test)", () => {
    expect(plannedMissingModule("Error: Cannot find module '/src/app' imported from apps/lambdas/evaluation/src/app.test.ts", touchpoints)).toBe("apps/lambdas/evaluation/src/app");
    expect(plannedMissingModule("Error: Cannot find module './routes/forms.routes' imported from apps/lambdas/evaluation/src/app.test.ts", touchpoints)).toBe("apps/lambdas/evaluation/src/routes/forms.routes");
  });

  it("takes an export the plan adds to a package whose package.json it touches", () => {
    expect(plannedMissingModule('Error: "./evaluation" is not exported under the conditions ["node","development","import"] from package @discover/ui', touchpoints)).toBe("packages/ui/package.json");
    expect(plannedMissingModule('Error: "./evaluation" is not exported from package @discover/ui (ui.contract.test.ts: 0 tests)', touchpoints)).toBe("packages/ui/package.json");
    // Node names the package by its folder in node_modules (DISC-53's S26, S27).
    expect(plannedMissingModule('Error: "./evaluation" is not exported under the conditions ["node","development","import"] from package /work/node_modules/@discover/ui', touchpoints)).toBe("packages/ui/package.json");
    expect(plannedMissingModule('Error: "./evaluation" is not exported from package /work/node_modules/@discover/application', touchpoints)).toBeNull();
  });

  it("takes an existence check or an ENOENT on a planned file: the writer's guard for code the plan creates (DISC-53's third round)", () => {
    expect(plannedMissingModule("AssertionError: apps/lambdas/evaluation/src/app.ts exists: expected false to be true", touchpoints)).toBe("apps/lambdas/evaluation/src/app.ts");
    expect(plannedMissingModule("Error: ENOENT: no such file or directory, open '/work/apps/lambdas/evaluation/src/routes/forms.routes.ts'", touchpoints)).toBe("apps/lambdas/evaluation/src/routes/forms.routes.ts");
    expect(plannedMissingModule("AssertionError: apps/api/src/app.ts exists: expected false to be true", touchpoints)).toBeNull();
    expect(plannedMissingModule("AssertionError: apps/lambdas/evaluation/src/app.ts exists: expected true to be false", touchpoints)).toBeNull();
  });

  it("matches a root import by a planned file ending in it, and never waives a path that doubles a folder (DISC-53's S6)", () => {
    expect(plannedMissingModule("Error: Cannot find module '/evaluation/src/app' imported from apps/lambdas/evaluation/src/legacyContract.integration.test.ts", touchpoints)).toBe("apps/lambdas/evaluation/src/app.ts");
    expect(plannedMissingModule("Error: Cannot find module '/evaluation/src/nope' imported from apps/lambdas/evaluation/src/x.test.ts", touchpoints)).toBeNull();
  });

  it("resolves against the scenario's test file when the output names the importer without its folder, or names none (DISC-53's S11)", () => {
    const file = "apps/lambdas/evaluation/src/app.test.ts";
    expect(plannedMissingModule("Error: Cannot find module '/src/app' imported from app.test.ts", touchpoints, file)).toBe("apps/lambdas/evaluation/src/app");
    expect(plannedMissingModule("Error: Cannot find module './routes/forms.routes'", touchpoints, file)).toBe("apps/lambdas/evaluation/src/routes/forms.routes");
    expect(plannedMissingModule("Error: Cannot find module '/src/app' imported from other.test.ts", touchpoints, file)).toBeNull();
  });

  it("reads a path under the container's checkout (/work/...) as repo-relative: Node names the importer by its absolute path (DISC-53's sixth attempt)", () => {
    expect(plannedMissingModule("Error: Cannot find module './app' imported from /work/apps/lambdas/evaluation/src/app.integration.test.ts", touchpoints)).toBe("apps/lambdas/evaluation/src/app");
    expect(plannedMissingModule("Error: Cannot find module '/work/apps/lambdas/evaluation/src/app'", touchpoints)).toBe("apps/lambdas/evaluation/src/app");
  });

  it("leaves everything else to the judge: an assertion, a third-party package, a typo outside the plan, an export of a package the plan does not touch", () => {
    expect(plannedMissingModule("AssertionError: expected 404 to be 200", touchpoints)).toBeNull();
    expect(plannedMissingModule("Error: Cannot find module 'lodash-es'", touchpoints)).toBeNull();
    expect(plannedMissingModule("Error: Cannot find module 'apps/lambdas/evalution/src/app'", touchpoints)).toBeNull();
    expect(plannedMissingModule("Error: Cannot find module './nope' imported from apps/api/src/x.test.ts", touchpoints)).toBeNull();
    expect(plannedMissingModule('Error: "./forms" is not exported from package @discover/application', touchpoints)).toBeNull();
    expect(plannedMissingModule("Error: Cannot find module 'apps/lambdas/evaluation/../../../etc/passwd'", touchpoints)).toBeNull();
  });
});
