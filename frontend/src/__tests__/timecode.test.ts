import { describe, it, expect } from "vitest";
import { fmtTimecode, parseTimecode } from "../lib/mel";

describe("timecode", () => {
  it("formats seconds as m:ss.cc with two decimals", () => {
    expect(fmtTimecode(0)).toBe("0:00.00");
    expect(fmtTimecode(5.3)).toBe("0:05.30");
    expect(fmtTimecode(64.2)).toBe("1:04.20");
    expect(fmtTimecode(605)).toBe("10:05.00");
  });

  it("clamps non-finite / negative to zero when formatting", () => {
    expect(fmtTimecode(-1)).toBe("0:00.00");
    expect(fmtTimecode(NaN)).toBe("0:00.00");
  });

  it("parses m:ss.cc and bare seconds", () => {
    expect(parseTimecode("1:04.20")).toBeCloseTo(64.2, 5);
    expect(parseTimecode("0:05.30")).toBeCloseTo(5.3, 5);
    expect(parseTimecode("83.5")).toBeCloseTo(83.5, 5);
    expect(parseTimecode("  2:00  ")).toBe(120);
  });

  it("round-trips through format → parse", () => {
    for (const t of [0, 5.3, 64.2, 123.45]) {
      expect(parseTimecode(fmtTimecode(t))).toBeCloseTo(t, 2);
    }
  });

  it("rejects unparseable / out-of-range timecodes", () => {
    expect(parseTimecode("")).toBeNull();
    expect(parseTimecode("abc")).toBeNull();
    expect(parseTimecode("1:60")).toBeNull(); // seconds must be < 60
    expect(parseTimecode("1:2:3")).toBeNull(); // only one colon allowed
    expect(parseTimecode("-4")).toBeNull(); // no negative times
  });
});
