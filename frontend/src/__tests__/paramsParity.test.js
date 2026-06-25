import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { FLUID_PARAMS, FLUID_PARAM_KEYS } from "../lib/fluidParams.js";

// Parity guard (spec 09): the frontend fluid param spec must agree with the
// backend's (backend/animation_params.PARAMS, snapshotted to fixtures/params.json
// via `python -c "...json.dump..."`). If they drift, signal->param range mapping
// would be wrong. We compare KEYS + min/max/def only — `group` legitimately differs
// (backend group = source/fluid nesting; frontend group = source/color/medium UI).
const params = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../../../specs/create-animation/fixtures/params.json", import.meta.url)),
    "utf8"
  )
);

describe("fluid param spec parity (frontend <-> backend)", () => {
  it("has the same set of param keys", () => {
    expect([...FLUID_PARAM_KEYS].sort()).toEqual(Object.keys(params).sort());
  });

  it("agrees on min/max/def for every param", () => {
    for (const p of FLUID_PARAMS) {
      const b = params[p.key];
      expect(b, `backend missing param ${p.key}`).toBeTruthy();
      expect(p.min, `${p.key}.min`).toBeCloseTo(b.min, 6);
      expect(p.max, `${p.key}.max`).toBeCloseTo(b.max, 6);
      expect(p.def, `${p.key}.def`).toBeCloseTo(b.def, 6);
    }
  });
});
