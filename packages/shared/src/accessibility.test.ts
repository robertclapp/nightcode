import { describe, expect, test } from "bun:test";
import {
  resolveAccessibilityPreferences,
  parseHexColor,
  relativeLuminance,
  contrastRatio,
  meetsContrast,
} from "./accessibility";

describe("resolveAccessibilityPreferences", () => {
  test("defaults: color on, everything else off", () => {
    expect(resolveAccessibilityPreferences({})).toEqual({
      useColor: true,
      noColor: false,
      highContrast: false,
      reducedMotion: false,
      asciiOnly: false,
      accessibleMode: false,
    });
  });

  test("NO_COLOR disables color for any non-empty value, ignores empty", () => {
    expect(resolveAccessibilityPreferences({ NO_COLOR: "1" }).noColor).toBe(true);
    expect(resolveAccessibilityPreferences({ NO_COLOR: "anything" }).useColor).toBe(false);
    expect(resolveAccessibilityPreferences({ NO_COLOR: "" }).noColor).toBe(false);
  });

  test("FORCE_COLOR overrides NO_COLOR", () => {
    expect(resolveAccessibilityPreferences({ NO_COLOR: "1", FORCE_COLOR: "1" }).useColor).toBe(true);
  });

  test("NIGHTCODE_ACCESSIBLE turns on the whole profile", () => {
    const p = resolveAccessibilityPreferences({ NIGHTCODE_ACCESSIBLE: "1" });
    expect(p.accessibleMode).toBe(true);
    expect(p.highContrast).toBe(true);
    expect(p.reducedMotion).toBe(true);
    expect(p.asciiOnly).toBe(true);
  });

  test("individual opt-ins", () => {
    expect(resolveAccessibilityPreferences({ NIGHTCODE_REDUCED_MOTION: "1" }).reducedMotion).toBe(
      true,
    );
    expect(resolveAccessibilityPreferences({ NIGHTCODE_ASCII: "true" }).asciiOnly).toBe(true);
    expect(resolveAccessibilityPreferences({ NIGHTCODE_HIGH_CONTRAST: "on" }).highContrast).toBe(
      true,
    );
  });

  test.each(["0", "false", "no", "off", ""])("treats %p as off", (value) => {
    expect(
      resolveAccessibilityPreferences({ NIGHTCODE_REDUCED_MOTION: value }).reducedMotion,
    ).toBe(false);
  });
});

describe("parseHexColor", () => {
  test("parses #rrggbb and #rgb", () => {
    expect(parseHexColor("#ffffff")).toEqual({ r: 255, g: 255, b: 255 });
    expect(parseHexColor("#000")).toEqual({ r: 0, g: 0, b: 0 });
    expect(parseHexColor("#FF8800")).toEqual({ r: 255, g: 136, b: 0 });
  });

  test("throws on malformed input", () => {
    expect(() => parseHexColor("nope")).toThrow();
    expect(() => parseHexColor("#12")).toThrow();
  });
});

describe("WCAG contrast math", () => {
  test("luminance extremes", () => {
    expect(relativeLuminance("#000000")).toBeCloseTo(0, 5);
    expect(relativeLuminance("#ffffff")).toBeCloseTo(1, 5);
  });

  test("black/white is 21:1 and symmetric", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 1);
    expect(contrastRatio("#ffffff", "#000000")).toBeCloseTo(21, 1);
  });

  test("identical colors are 1:1", () => {
    expect(contrastRatio("#3366cc", "#3366cc")).toBeCloseTo(1, 5);
  });

  test("meetsContrast applies the right thresholds", () => {
    expect(meetsContrast("#ffffff", "#000000", "AAA")).toBe(true);
    expect(meetsContrast("#cccccc", "#000000", "AA")).toBe(true);
    expect(meetsContrast("#444444", "#000000", "AA")).toBe(false);
    // A pair (~3.9:1) that clears AA-large (3:1) but not AA-normal (4.5:1).
    const dim = "#6a6a6a";
    expect(meetsContrast(dim, "#000000", "AA", true)).toBe(true);
    expect(meetsContrast(dim, "#000000", "AA", false)).toBe(false);
  });
});
