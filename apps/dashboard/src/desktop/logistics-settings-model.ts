import type { DesktopLogisticsProfile, DesktopLogisticsProfileInput } from "@lxe/desktop-protocol";
export function logisticsProfileInput(profile: DesktopLogisticsProfile): DesktopLogisticsProfileInput {
  return { profile_id: profile.profile_id, display_name: profile.display_name, provider_id: profile.provider_id,
    enabled: profile.enabled,
    login_username: profile.login_username };
}
