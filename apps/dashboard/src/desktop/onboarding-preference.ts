export const ONBOARDING_DISMISSED_STORAGE_KEY = "lxe.window.main.onboarding-dismissed.v1";

type PreferenceStorage = Pick<Storage, "getItem" | "setItem">;

function browserStorage(): PreferenceStorage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

export function initialOnboardingDismissed(
  storage: PreferenceStorage | undefined = browserStorage(),
): boolean {
  try {
    return storage?.getItem(ONBOARDING_DISMISSED_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

export function storeOnboardingDismissed(
  storage: PreferenceStorage | undefined = browserStorage(),
): void {
  try {
    storage?.setItem(ONBOARDING_DISMISSED_STORAGE_KEY, "true");
  } catch {
    // Skipping remains effective for this window when persistent storage is unavailable.
  }
}
