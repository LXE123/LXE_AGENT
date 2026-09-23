import { text, type DesktopSecrets } from "./model";

export function effectiveDesktopSecrets(
  persisted: DesktopSecrets,
  environment: Readonly<Record<string, string | undefined>> = {},
): DesktopSecrets {
  const effective = structuredClone(persisted);
  const values = {
    ziniao_password: text(environment.ZINIAO_PASSWORD),
    mabang_password: text(environment.MABANG_PASSWORD),
    feishu_app_secret: text(environment.FEISHU_APP_SECRET),
  } satisfies Partial<DesktopSecrets>;
  for (const [name, value] of Object.entries(values)) {
    if (value) effective[name as keyof typeof values] = value;
  }
  if (!persisted.shangman_processed_password) effective.shangman_processed_password = text(environment.LXE_SHANGMAN_PROCESSED_PASSWORD);
  if (!persisted.yacang_password) effective.yacang_password = (environment.LXE_YACANG_PASSWORD ?? "");
  return effective;
}
