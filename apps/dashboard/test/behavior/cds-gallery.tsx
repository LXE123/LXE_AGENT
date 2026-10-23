import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { I18nContext, UI_TEXT } from "../../src/shared/i18n";
import { SessionsIndex, UnifiedConversationRow } from "../../src/features/sessions/view";
import type { ToolOperation } from "../../src/features/sessions/conversation";
import type { SessionPayload } from "../../src/api/payloads";
import adaptation from "../../../../docs/design/cds/current-adaptation.json";
import "../../src/styles.css";
import "../../src/desktop/settings-theme.css";
import "../../src/features/sessions/sidebar-theme.css";
import "./cds-gallery.css";

type Family = "field" | "navigation" | "tool";
const families = adaptation.components;
const params = new URLSearchParams(location.search);
const familyFrom = (value: string | null): Family => value === "navigation" || value === "tool" ? value : "field";
const initialFamily = familyFrom(params.get("component"));
const sample = params.get("sample") === "1";
const theme = params.get("theme") === "dark" ? "dark" : "light";
document.documentElement.dataset.theme = sample ? theme : "light";
document.body.className = sample ? `cds-sample-body sample-${initialFamily}` : "cds-gallery-body";
const noAction = () => {};
const asyncNoAction = async () => {};

function Fields() {
  return <div className="desktop-settings-theme">
    <div className="desktop-settings-content gallery-fields">
      <p className="sample-intro">设置页的原生字段与生产样式。可直接输入，用 Tab 检查焦点。</p>
      {/* shell.tsx currently owns inline native inputs, not a reusable React field.
          Keep their theme ancestors and native semantics; do not paint invented states. */}
      <div className="desktop-field-grid">
        <label><span>普通输入框<small>默认 · 悬停 · 焦点</small></span>
          <input id="field-normal" aria-label="普通输入框" placeholder="输入工作区名称" defaultValue="LXE 设计资料" /></label>
        <label><span>禁用输入框<small>当前整体 opacity 为 .4</small></span>
          <input id="field-disabled" aria-label="禁用输入框" disabled defaultValue="保存期间不可编辑" /></label>
        <label><span>错误状态探针<small>实现缺口 · 不是产品错误流程</small></span>
          <input id="field-invalid" aria-label="错误状态探针" aria-invalid="true" aria-describedby="field-gap" defaultValue="示例无效值" /></label>
      </div>
      <p id="field-gap" className="sample-gap">缺口：现有样式没有响应 aria-invalid 的专用边界与焦点环。这里如实展示普通边界／蓝色焦点。</p>
    </div>
  </div>;
}

function session(id: string, title: string): SessionPayload {
  return { session_id: id, title, permission_mode: "workspace-write", workspace_id: "cds-gallery",
    workspace: { directory: "/fixture/cds-gallery", worktree: "/fixture/cds-gallery" },
    pinned_at: 0, created_at: 1, last_active_at: 1, source: { platform: "desktop" }, source_summary: { platform: "desktop", chat_type: "p2p" },
    model: "fixture-model", reasoning_effort: "", model_config: {}, message_count: 0, tool_call_count: 0, input_tokens: 0, output_tokens: 0, api_call_count: 0 };
}
function Navigation() {
  const [selected, setSelected] = useState("nav-selected");
  const [items, setItems] = useState(() => [
    session("nav-default", "整理 CDS 组件资料"),
    session("nav-selected", "检查亮暗主题的交互状态"),
    session("nav-long", "一条用于检查省略和操作按钮遮罩的很长会话标题：输入框、导航行与工具调用条"),
  ]);
  return <div>
    <p className="sample-intro">选中行持续保留背景。点击切换会话，用 Tab / Enter 检查键盘导航。</p>
    <aside className="app-sidebar conversation-chrome-theme gallery-sidebar" aria-label="会话导航样本">
      <div className="sidebar-session-section">
        <SessionsIndex embedded sessions={items} query="" searchOpen={false}
          initialLoading={false} loadingMore={false} error="" hasMore={false} loadMoreError=""
          selectedSessionId={selected} onQueryChange={noAction} onSearchClose={noAction} onLoadMore={noAction}
          onNew={noAction} onOpen={item => setSelected(item.session_id)}
          onPin={async (item, pinned) => setItems(value => value.map(row => row.session_id === item.session_id ? { ...row, pinned_at: pinned ? 1 : 0 } : row))}
          onDelete={async item => setItems(value => value.filter(row => row.session_id !== item.session_id))} />
      </div>
    </aside>
    <p className="sample-gap">边界：上游直接证据来自设置导航；会话导航的混色比例是 LXE 选择。此组件没有整行禁用／错误接口。</p>
  </div>;
}

const toolStates: ToolOperation["status"][] = ["pending", "running", "success", "error", "unconfirmed"];
function Tools() {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  return <div>
    <p className="sample-intro">五种执行状态。悬停看文字，点击展开参数与示例结果。命令不会执行。</p>
    <div className="conversation-feed gallery-tools">
      {toolStates.map(status => {
        const id = `tool-${status}`;
        const command = "lxeskill list";
        const operation: ToolOperation = { key: id, name: "bash", argument: command, action: "run", target: command, status,
          call: { type: "tool_use", id, name: "bash", input: { command } },
          result: status === "error" ? { type: "tool_result", content: "示例数据：PermissionError: fixture access denied", is_error: true }
            : status === "success" ? { type: "tool_result", content: "示例数据：3 个命令已列出；未实际执行。" } : undefined };
        return <div className="gallery-tool-case" id={id} key={id}>
          <p className="sample-caption">{UI_TEXT.zh.message.toolStatuses[status]} <code>{status}</code></p>
          <UnifiedConversationRow row={{ id, kind: "tool", groupId: "gallery", turnId: "gallery", createdAt: 1, operation }}
            expanded={expanded.has(id)} onToggle={() => setExpanded(value => {
              const next = new Set(value); next.has(id) ? next.delete(id) : next.add(id); return next;
            })}
            onOpenFile={asyncNoAction} onRevealFile={asyncNoAction} onOpenAttachment={asyncNoAction} />
        </div>;
      })}
    </div>
    <p className="sample-gap">缺口：未确认 Claude 工具条专用规则；默认配色和焦点边框仍含旧主题变量。当前分支没有禁用接口。</p>
  </div>;
}

function Sample() {
  const [inspection, setInspection] = useState("移入组件或用 Tab 聚焦，查看浏览器的实际样式。");
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const inspect = (event: Event) => {
      const target = event.target instanceof Element ? event.target.closest("input, .session-index-open, .tool-op-summary") : null;
      if (!target) return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        const style = getComputedStyle(target);
        const item = target.closest(".session-index-item");
        const text = target.querySelector(".tool-op-argument") ?? target;
        const states = [target.matches(":hover") && "悬停", target.matches(":focus-visible") && "焦点",
          target.matches(":disabled") && "禁用", target.getAttribute("aria-invalid") === "true" && "错误探针",
          item?.classList.contains("active") && "选中", target.getAttribute("aria-expanded") === "true" && "展开"].filter(Boolean);
        setInspection(`${states.join(" + ") || "默认"}\n背景  ${getComputedStyle(item ?? target).backgroundColor}\n文字  ${getComputedStyle(text).color}\n边框  ${style.borderColor}\n焦点  ${style.outline}\n阴影  ${style.boxShadow}\n透明度  ${style.opacity}`);
      }, 150);
    };
    document.addEventListener("pointerover", inspect);
    document.addEventListener("pointerout", inspect);
    document.addEventListener("focusin", inspect);
    document.addEventListener("focusout", inspect);
    document.addEventListener("click", inspect);
    // No parent frame can change production state; only report intrinsic height.
    const observer = new ResizeObserver(() => parent.postMessage({ type: "cds-gallery-height", theme, height: document.body.scrollHeight }, location.origin));
    observer.observe(ref.current!);
    return () => {
      observer.disconnect(); clearTimeout(timer);
      for (const name of ["pointerover", "pointerout", "focusin", "focusout", "click"]) document.removeEventListener(name, inspect);
    };
  }, []);
  return <I18nContext.Provider value={UI_TEXT.zh}><div ref={ref} className="sample-root">
    {initialFamily === "field" ? <Fields /> : initialFamily === "navigation" ? <Navigation /> : <Tools />}
    <details className="sample-inspector"><summary>查看当前计算样式</summary><pre>{inspection}</pre></details>
  </div></I18nContext.Provider>;
}

function Gallery() {
  const [family, setFamily] = useState<Family>(initialFamily);
  const [revision, setRevision] = useState(0);
  const [height, setHeight] = useState<Record<string, number>>({});
  const component = families.find(item => item.id === family)!;
  const light = useRef<HTMLIFrameElement>(null), dark = useRef<HTMLIFrameElement>(null);
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (event.origin !== location.origin) return;
      const matchedTheme = event.source === light.current?.contentWindow ? "light" : event.source === dark.current?.contentWindow ? "dark" : null;
      if (matchedTheme && event.data?.type === "cds-gallery-height" && Number.isFinite(event.data.height)) {
        setHeight(value => ({ ...value, [matchedTheme]: Math.max(250, Math.min(2200, event.data.height + 4)) }));
      }
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, []);
  const choose = (id: Family) => {
    setFamily(id); setHeight({});
    const url = new URL(location.href); url.searchParams.set("component", id); history.replaceState(null, "", url);
  };
  const frameUrl = (mode: string) => {
    const url = new URL(location.href);
    url.search = new URLSearchParams({ sample: "1", component: family, theme: mode, revision: String(revision) }).toString();
    return url.href;
  };
  return <main className="gallery-shell conversation-chrome-theme">
    <header className="gallery-header">
      <div><p className="gallery-context">LXE Agent / CDS 适配资料</p><h1>组件状态展示</h1>
        <p className="gallery-description">把亮暗主题放在一起，检查每一次悬停、选择与聚焦。</p></div>
      <a className="gallery-link" href="#adaptation">查看当前适配表</a>
    </header>
    <div className="gallery-toolbar">
      <nav aria-label="组件类别">{families.map(item => <button type="button" key={item.id} aria-current={family === item.id ? "page" : undefined}
        onClick={() => choose(item.id as Family)}>{item.title}</button>)}</nav>
      <button type="button" className="gallery-reset" onClick={() => { setRevision(value => value + 1); setHeight({}); }}>重置样本</button>
    </div>
    <section className="gallery-explanation">
      <span className="gallery-reuse">{component.reuse}</span>
      <p>{component.instructions}</p>
    </section>
    <div className="gallery-pair" key={`${family}-${revision}`}>
      {["light", "dark"].map(mode => <section key={mode} className={`gallery-pane pane-${mode}`}>
        <h2>{mode === "light" ? "浅色" : "暗色"}<small>独立主题作用域</small></h2>
        <iframe ref={mode === "light" ? light : dark} title={`${component.title} · ${mode === "light" ? "浅色" : "暗色"}`}
          src={frameUrl(mode)} style={{ height: Math.max(height.light ?? 400, height.dark ?? 400) }} />
      </section>)}
    </div>
    <section className="gallery-evidence" id="adaptation">
      <div className="gallery-section-heading"><h2>当前适配表</h2><span>首批 3 类组件 · {adaptation.reviewedOn}</span></div>
      <p>{component.scope}</p>
      <div className="gallery-table-scroll"><table>
        <thead><tr><th>状态</th><th>当前实现</th><th>证据与边界</th></tr></thead>
        <tbody>{component.states.map(state => <tr key={state.id}><th scope="row">{state.label}</th>
          <td>{state.lxe}</td><td><span className={`gallery-tag ${["实现缺口", "已知偏差"].includes(state.classification) ? "gap" : ""}`}>{state.classification}</span>
            <p>{state.upstream.length ? state.upstream.join("、") : "未取得专用上游依据 / 本地接口判断"}</p></td></tr>)}</tbody>
      </table></div>
      <details className="gallery-sources"><summary>原始出处、源码位置与未验证项</summary>
        <ul>{component.implementation.map(file => <li key={file}><code>{file}</code></li>)}</ul>
        {adaptation.sources.filter(source => component.states.some(state => state.upstream.includes(source.id))).map(source =>
          <p key={source.id}><strong>{source.id} · {source.kind}</strong><br /><code>{source.file}</code><br />{source.locator}。{source.note}</p>)}
        <ul>{component.gaps.map(gap => <li key={gap}>{gap}</li>)}</ul>
      </details>
    </section>
    <footer className="gallery-footer"><p>上游来源：{adaptation.upstreamVersion}。</p>
      <p>样本全部使用本地示例数据。亮暗表现一致不等于完成无障碍审计；本地验证也不等于已证实 Claude 的运行时实现。</p></footer>
  </main>;
}
createRoot(document.getElementById("root")!).render(sample ? <Sample /> : <Gallery />);
