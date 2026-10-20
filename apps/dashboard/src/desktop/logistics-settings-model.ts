import type { DesktopLogisticsProfile, DesktopLogisticsSettingsState, DesktopLogisticsProfileInput } from "@lxe/desktop-protocol";

export type LogisticsBindingStatus = "disabled" | "public" | "unavailable" | "missing" | "ambiguous" | "renamed" | "stopped" | "ready";
export function logisticsBindingStatus(profile: DesktopLogisticsProfileInput, state: DesktopLogisticsSettingsState): LogisticsBindingStatus {
  if (!profile.enabled) return "disabled";
  if (!profile.store_binding) return "public";
  if (state.stores_error) return "unavailable";
  const matches = state.stores.filter(store => store.store_id === profile.store_binding?.store_id);
  if (!matches.length) return "missing";
  if (matches.length !== 1) return "ambiguous";
  const store = matches[0]!;
  if (store.store_name !== profile.store_binding.store_name) return "renamed";
  return store.running ? "ready" : "stopped";
}
export function logisticsProfileInput(profile: DesktopLogisticsProfile): DesktopLogisticsProfileInput {
  return { profile_id: profile.profile_id, display_name: profile.display_name, provider_id: profile.provider_id,
    enabled: profile.enabled, store_binding: profile.store_binding,
    login_username: profile.login_username };
}
