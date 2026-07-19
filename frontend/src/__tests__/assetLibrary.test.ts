import { describe, it, expect } from "vitest";
import { groupByFolder } from "../components/assets/AssetLibrary";
import type { Asset } from "../lib/types";

const a = (name: string, folder?: string): Asset => ({
  id: name,
  url: `/assets/j/${name}.mp4`,
  kind: "video",
  name,
  addedAt: 0,
  ...(folder ? { folder } : {}),
});

describe("groupByFolder", () => {
  it("puts loose assets first, then folders alphabetically", () => {
    const groups = groupByFolder([a("x", "B"), a("y"), a("z", "A")]);
    expect(groups.map((g) => g.folder)).toEqual(["", "A", "B"]);
  });

  it("sorts WITHIN a folder by name — phone clips encode their shot time there", () => {
    // Deliberately scrambled insertion order (a deduping re-upload does this).
    const groups = groupByFolder([
      a("PXL_20260503_2036", "May 2026/2026-05-03"),
      a("PXL_20260503_0904", "May 2026/2026-05-03"),
      a("PXL_20260503_1851", "May 2026/2026-05-03"),
    ]);
    expect(groups[0].items.map((x) => x.name)).toEqual([
      "PXL_20260503_0904",
      "PXL_20260503_1851",
      "PXL_20260503_2036",
    ]);
  });

  it("keeps loose assets in insertion (upload-history) order", () => {
    const groups = groupByFolder([a("b"), a("a"), a("c")]);
    expect(groups[0].items.map((x) => x.name)).toEqual(["b", "a", "c"]);
  });
});
