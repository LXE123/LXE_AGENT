import { describe, expect, test } from "bun:test";

import {
  initialOnboardingDismissed,
  ONBOARDING_DISMISSED_STORAGE_KEY,
  storeOnboardingDismissed,
} from "../../src/desktop/onboarding-preference";

describe("desktop onboarding preference", () => {
  test("shows onboarding until it has been dismissed", () => {
    expect(initialOnboardingDismissed(undefined)).toBe(false);
    expect(initialOnboardingDismissed({
      getItem: () => null,
      setItem: () => undefined,
    })).toBe(false);
    expect(initialOnboardingDismissed({
      getItem: () => "false",
      setItem: () => undefined,
    })).toBe(false);
    expect(initialOnboardingDismissed({
      getItem: () => "true",
      setItem: () => undefined,
    })).toBe(true);
  });

  test("persists dismissal and tolerates unavailable storage", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    };
    storeOnboardingDismissed(storage);
    expect(values.get(ONBOARDING_DISMISSED_STORAGE_KEY)).toBe("true");
    expect(initialOnboardingDismissed(storage)).toBe(true);

    const unavailable = {
      getItem: () => { throw new Error("blocked"); },
      setItem: () => { throw new Error("blocked"); },
    };
    expect(initialOnboardingDismissed(unavailable)).toBe(false);
    expect(() => storeOnboardingDismissed(unavailable)).not.toThrow();
  });
});
