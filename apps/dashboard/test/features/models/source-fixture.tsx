// Browser acceptance uses the production view and synthetic public model metadata only.
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { ModelsView } from "../../../src/features/models/view";
import { I18nContext, UI_TEXT } from "../../../src/shared/i18n";
import { sourceFixtureModels } from "./source-fixtures";
import "../../../src/styles.css";

function Fixture() {
  const [models, setModels] = useState(sourceFixtureModels);
  const [source, setSource] = useState<"cloud" | "local">("cloud");
  const [english, setEnglish] = useState(false);
  const current = { ...sourceFixtureModels().find(m => m.provider === "deepseek" && m.credential_source === source)!, model: "deepseek-v4-flash" };
  return <I18nContext.Provider value={english ? UI_TEXT.en : UI_TEXT.zh}>
    <main style={{ padding: 24 }}>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 20 }}>
        <button onClick={() => setModels(sourceFixtureModels())}>Restore publication</button>
        <button onClick={() => setModels(rows => rows.filter(m => m.credential_source !== "cloud" || m.model !== "deepseek-flash"))}>Remove future cloud model</button>
        <button onClick={() => setModels(rows => rows.filter(m => m.credential_source !== "cloud"))}>Disable cloud models</button>
        <button onClick={() => setSource(value => value === "cloud" ? "local" : "cloud")}>Toggle current source</button>
        <button onClick={() => setEnglish(value => !value)}>Toggle language</button>
        <button onClick={() => { document.documentElement.dataset.theme = document.documentElement.dataset.theme === "dark" ? "light" : "dark"; }}>Toggle theme</button>
        <output id="fixture-current">{source} / deepseek / {current.model}</output>
      </div>
      <ModelsView models={models} current={current} />
    </main>
  </I18nContext.Provider>;
}
const root = createRoot(document.getElementById("root")!);
root.render(<Fixture />);
if (import.meta.hot) import.meta.hot.dispose(() => root.unmount());
