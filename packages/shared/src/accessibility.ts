/**
 * Accessibility primitives.
 *
 * Two pure, dependency-free concerns used to make the terminal UI usable for
 * low-vision, color-blind, and motion-sensitive users:
 *
 * 1. Preference resolution from the environment — honoring the `NO_COLOR`
 *    standard plus opt-in switches for reduced motion, ASCII-only rendering,
 *    and a high-contrast profile.
 * 2. WCAG contrast math — so themes can be audited and a guaranteed-readable
 *    high-contrast theme can be verified rather than eyeballed.
 *
 * Kept side-effect-free so it can be unit tested and reused on client + server.
 */

export type AccessibilityPreferences = {
  /** Whether ANSI color should be emitted at all. */
  useColor: boolean;
  /** Convenience inverse of useColor. */
  noColor: boolean;
  /** Prefer a high-contrast palette. */
  highContrast: boolean;
  /** Replace animations (spinners) with static indicators. */
  reducedMotion: boolean;
  /** Avoid box-drawing/Unicode glyphs that braille displays mishandle. */
  asciiOnly: boolean;
  /** Master switch — turns on the most accessible profile at once. */
  accessibleMode: boolean;
};

/** Values that count as "off" for an opt-in flag. */
const OFF_VALUES = new Set(["", "0", "false", "no", "off"]);

/** True when an env var is present and not an explicit "off" value. */
export function isEnabled(value: string | undefined): boolean {
  return value != null && !OFF_VALUES.has(value.trim().toLowerCase());
}

/**
 * Resolve accessibility preferences from an environment record.
 *
 * Recognized variables:
 * - `NO_COLOR`        — disables color when present and non-empty (no-color.org).
 * - `FORCE_COLOR`     — forces color on, overriding `NO_COLOR`.
 * - `NIGHTCODE_ACCESSIBLE`     — master switch (implies the others below).
 * - `NIGHTCODE_HIGH_CONTRAST`  — prefer the high-contrast theme.
 * - `NIGHTCODE_REDUCED_MOTION` — static indicators instead of animations.
 * - `NIGHTCODE_ASCII`          — ASCII-only borders/glyphs.
 */
export function resolveAccessibilityPreferences(
  env: Record<string, string | undefined> = process.env,
): AccessibilityPreferences {
  const accessibleMode = isEnabled(env.NIGHTCODE_ACCESSIBLE);

  // NO_COLOR counts when present and non-empty, regardless of value; FORCE_COLOR
  // is an explicit opt-in that wins if both are set.
  const noColorRequested = env.NO_COLOR != null && env.NO_COLOR !== "";
  const useColor = isEnabled(env.FORCE_COLOR) || !noColorRequested;

  return {
    useColor,
    noColor: !useColor,
    highContrast: accessibleMode || isEnabled(env.NIGHTCODE_HIGH_CONTRAST),
    reducedMotion: accessibleMode || isEnabled(env.NIGHTCODE_REDUCED_MOTION),
    asciiOnly: accessibleMode || isEnabled(env.NIGHTCODE_ASCII),
    accessibleMode,
  };
}

type Rgb = { r: number; g: number; b: number };

/** Parse `#rgb` or `#rrggbb` into 0–255 channels. Throws on malformed input. */
export function parseHexColor(hex: string): Rgb {
  const cleaned = hex.trim().replace(/^#/, "");
  const full =
    cleaned.length === 3
      ? cleaned
          .split("")
          .map((c) => c + c)
          .join("")
      : cleaned;
  if (!/^[0-9a-fA-F]{6}$/.test(full)) {
    throw new Error(`Invalid hex color: ${hex}`);
  }
  return {
    r: parseInt(full.slice(0, 2), 16),
    g: parseInt(full.slice(2, 4), 16),
    b: parseInt(full.slice(4, 6), 16),
  };
}

function channelToLinear(channel: number): number {
  const c = channel / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** WCAG relative luminance (0 = black, 1 = white). */
export function relativeLuminance(hex: string): number {
  const { r, g, b } = parseHexColor(hex);
  return 0.2126 * channelToLinear(r) + 0.7152 * channelToLinear(g) + 0.0722 * channelToLinear(b);
}

/** WCAG contrast ratio between two colors (1:1 … 21:1). */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}

export type ContrastLevel = "AA" | "AAA";

/** Whether `fg` on `bg` clears the WCAG threshold for the given level/size. */
export function meetsContrast(
  fg: string,
  bg: string,
  level: ContrastLevel = "AA",
  largeText = false,
): boolean {
  const ratio = contrastRatio(fg, bg);
  const threshold = level === "AAA" ? (largeText ? 4.5 : 7) : largeText ? 3 : 4.5;
  return ratio >= threshold;
}
