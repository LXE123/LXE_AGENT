import { expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import type { FeishuOwnerPayload } from "@lxe/desktop-protocol";
import { dashboardQueryKeys } from "../../src/api/query-keys";
import { FeishuOwnerPanel } from "../../src/desktop/feishu-owner-panel";
import { I18nContext, UI_TEXT } from "../../src/shared/i18n";

const owner: FeishuOwnerPayload = {
  available: true, paired: false, owner_open_id_masked: "", paired_at: "", pairing: null,
};

const render = (payload: FeishuOwnerPayload, language: "zh" | "en" = "zh") => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(dashboardQueryKeys.channelHealth.feishuOwner, payload);
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <I18nContext.Provider value={UI_TEXT[language]}><FeishuOwnerPanel /></I18nContext.Provider>
    </QueryClientProvider>,
  );
};

test.each(["zh", "en"] as const)("an unpaired channel says every message is refused and offers pairing in %s", (language) => {
  const text = UI_TEXT[language].desktop.feishu.owner;
  const html = render(owner, language);
  expect(html).toContain(text.unpaired);
  expect(html).toContain(text.pair);
  expect(html).not.toContain("<code>");
});

test("a live pairing code is shown with how to use it", () => {
  const html = render({ ...owner, pairing: { code: "482915", expires_at: "2026-01-01T00:10:00.000Z" } });
  expect(html).toContain("<code>482915</code>");
  expect(html).toContain("私聊机器人并发送这个配对码");
  expect(html).toContain(UI_TEXT.zh.desktop.feishu.owner.newCode);
});

test("a paired channel shows the masked owner and offers pairing again", () => {
  const html = render({ ...owner, paired: true, owner_open_id_masked: "ou_ab…xyz", paired_at: "2026-01-01T00:00:00.000Z" });
  expect(html).toContain("已绑定 ou_ab…xyz");
  expect(html).toContain(UI_TEXT.zh.desktop.feishu.owner.rebind);
});

test("an unavailable channel explains it is not running and hides the button", () => {
  const html = render({ ...owner, available: false });
  expect(html).toContain(UI_TEXT.zh.desktop.feishu.owner.unavailable);
  expect(html).not.toContain("<button");
});
