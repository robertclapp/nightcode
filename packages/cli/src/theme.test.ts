import { describe, expect, test } from "bun:test";
import { Mode, parseHexColor } from "@nightcode/shared";
import {
  THEMES,
  DEFAULT_THEME,
  HIGH_CONTRAST_THEME,
  MONOCHROME_THEME,
  auditThemeContrast,
  themeMeetsContrast,
  getModeColor,
} from "./theme";

describe("accessible themes", () => {
  test("High Contrast clears WCAG AAA for every text color", () => {
    expect(HIGH_CONTRAST_THEME).toBeDefined();
    expect(themeMeetsContrast(HIGH_CONTRAST_THEME, "AAA")).toBe(true);
    expect(auditThemeContrast(HIGH_CONTRAST_THEME).minRatio).toBeGreaterThanOrEqual(7);
  });

  test("Monochrome clears WCAG AAA and uses only achromatic colors", () => {
    expect(themeMeetsContrast(MONOCHROME_THEME, "AAA")).toBe(true);
    for (const hex of Object.values(MONOCHROME_THEME.colors)) {
      const { r, g, b } = parseHexColor(hex);
      expect(r === g && g === b).toBe(true); // no hue, only brightness
    }
  });

  test("both accessible themes are registered", () => {
    const names = THEMES.map((theme) => theme.name);
    expect(names).toContain("High Contrast");
    expect(names).toContain("Monochrome");
  });
});

describe("getModeColor", () => {
  test("maps each agent to a distinct theme color", () => {
    const c = DEFAULT_THEME.colors;
    expect(getModeColor(Mode.BUILD, c)).toBe(c.primary);
    expect(getModeColor(Mode.PLAN, c)).toBe(c.planMode);
    expect(getModeColor(Mode.FIX, c)).toBe(c.success);
  });
});
