// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";

import ExportStep from "../components/export/ExportStep";
import { DOC_SECTION_IDS } from "../components/Docs";
import { EXPORT_DEFAULTS } from "../lib/export";
import type { OutputSettings } from "../lib/types";

// CLAUDE.md: "every new user-facing control gets a '?' that deep-links into the guide".
// paramHelp.test.tsx enforces that for palette CARDS — and only for cards, which is why
// the step screens drifted: ExportStep rendered five settings controls with no help at
// all, while Docs.tsx carried prose for `export` and `animation-output-hd` that nothing
// linked to. Orphaned prose on one side, an unexplained control on the other.
//
// This is the screen-level half of that guard. It is deliberately narrow: it asserts a
// screen has SOME help and that every section it points at exists, rather than counting
// badges (which would turn every layout tweak into a test edit).

vi.mock("../lib/api", () => ({
  getExportStatus: vi.fn(),
  startExport: vi.fn(),
  cancelExport: vi.fn(),
}));

const canvas: OutputSettings = { width: 1080, height: 1920, quality: "normal", fps: 24 };

describe("step screens explain themselves", () => {
  it("ExportStep's settings each carry a '?'", () => {
    const { container } = render(
      <ExportStep
        job="j1"
        segments={[]}
        exportSettings={{ ...EXPORT_DEFAULTS, width: 1080, height: 1920 }}
        setExportSettings={() => {}}
        output={canvas}
        onBack={() => {}}
      />
    );
    // size, fps, detail/grid, HD image size, audio
    const badges = container.querySelectorAll('[role="note"]');
    expect(badges.length).toBeGreaterThanOrEqual(5);
  });

  it("every '?' on the export screen opens a section the guide actually renders", () => {
    // A badge pointing at a dead anchor is worse than no badge: it looks like help and
    // lands the reader nowhere.
    const { container } = render(
      <ExportStep
        job="j1"
        segments={[]}
        exportSettings={{ ...EXPORT_DEFAULTS, width: 1080, height: 1920 }}
        setExportSettings={() => {}}
        output={canvas}
        onBack={() => {}}
      />
    );
    const ids = new Set<string>(DOC_SECTION_IDS);
    const links = [...container.querySelectorAll('a[role="note"]')];
    expect(links.length).toBeGreaterThan(0);
    for (const a of links) {
      const section = (a.getAttribute("href") || "").replace("/?doc=", "");
      expect(ids.has(section), `"?" links to #${section}, which the guide does not render`).toBe(
        true
      );
    }
  });
});
