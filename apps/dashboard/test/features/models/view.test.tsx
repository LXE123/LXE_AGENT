import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ModelsView } from "../../../src/features/models/view";
import { I18nContext, UI_TEXT } from "../../../src/shared/i18n";
import { sourceFixtureModels } from "./source-fixtures";

const articles = (markup: string) => [...markup.matchAll(/<article\b[^>]*>[\s\S]*?<\/article>/g)].map(m => m[0]);
const render = (source: "cloud" | "local", model = "deepseek-v4-flash") => {
  const models = sourceFixtureModels();
  const current = { ...models.find(m => m.provider === "deepseek" && m.credential_source === source)!, model };
  return renderToStaticMarkup(<ModelsView models={models} current={current} />);
};

describe("source-separated model gallery", () => {
  test("shows cloud first, counts each section, and uses supplier names", () => {
    const markup = render("cloud");
    expect(markup.indexOf('data-model-source="cloud"')).toBeLessThan(markup.indexOf('data-model-source="local"'));
    expect(markup).toContain("<strong>2</strong> 模型厂商");
    expect(markup).toContain("<strong>3</strong> 模型版本");
    expect(markup).toContain("<strong>5</strong> 模型厂商");
    expect(markup).toContain("<strong>7</strong> 模型版本");
    expect(markup).not.toContain("<h3>Company Flash</h3>");
    expect(markup).toContain("<h3>Zhipu AI Coding Plan</h3>");
    expect(markup).toContain("使用本机保存的个人 Key，模型请求仍发送给供应商。");
  });

  test.each(["cloud", "local"] as const)("highlights only the %s card and target when IDs overlap", source => {
    const markup = render(source);
    const cards = articles(markup).filter(m => m.includes('data-provider="deepseek"'));
    expect(cards).toHaveLength(2);
    for (const card of cards) {
      const active = card.includes(`data-credential-source="${source}"`);
      expect(card.includes('class="model-current-badge"')).toBe(active);
      expect(card.includes('class="model-variant-current"')).toBe(active);
      expect(card.includes('class="active"')).toBe(active);
      expect(card.includes('class="metric-positive"')).toBe(card.includes('data-credential-source="cloud"'));
    }
  });

  test("renders a selected cloud model failure and its own capabilities", () => {
    const card = articles(render("cloud", "deepseek-flash")).find(m => m.includes('data-provider="deepseek"') && m.includes('data-credential-source="cloud"'))!;
    expect(card).toContain("公司模型凭据不可用");
    expect(card).toContain("不可用");
    expect(card).toContain('aria-label="3,000,000"');
    expect(card).not.toContain('class="metric-positive"');
    expect(card).not.toContain('class="model-source-chip-state configured"');
  });

  test("empty cloud publication leaves personal suppliers visible, including unconfigured ones", () => {
    const models = sourceFixtureModels().filter(m => m.credential_source === "local");
    const markup = renderToStaticMarkup(<ModelsView models={models} current={models[0]!} />);
    expect(markup).toContain("公司暂未提供云端模型");
    expect(articles(markup)).toHaveLength(5);
    expect(markup).toContain("未配置");
    expect(markup).toContain("<strong>0</strong> 模型厂商");
  });

  test("English labels distinguish sources and preserve the same empty-state behavior", () => {
    const markup = renderToStaticMarkup(<I18nContext.Provider value={UI_TEXT.en}><ModelsView models={[]} current={null} /></I18nContext.Provider>);
    expect(markup).toContain("Cloud models");
    expect(markup).toContain("Local models");
    expect(markup).toContain("Your company has not published any cloud models");
  });
});
