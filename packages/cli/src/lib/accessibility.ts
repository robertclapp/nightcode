import { resolveAccessibilityPreferences, type AccessibilityPreferences } from "@nightcode/shared";

// Accessibility preferences are environment-driven and don't change within a
// process, so resolve them once and reuse the result everywhere.
let cached: AccessibilityPreferences | undefined;

export function accessibility(): AccessibilityPreferences {
  return (cached ??= resolveAccessibilityPreferences(process.env));
}
