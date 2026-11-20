import { ChevronRight, FolderTree, Grid2X2, List, Tag, SlidersHorizontal, CalendarDays, Warehouse } from "lucide-react";
import { useState, type ReactNode } from "react";
import { workbenchTools, type WorkbenchIndexView, type WorkbenchView, type WorkbenchToolView } from "../../shared/navigation";
import { useUiText } from "../../shared/i18n";

export type WorkbenchLayout = "list" | "grid";
const LAYOUT_STORAGE_KEY = "lxe.workbench.layout.v1";

/** The directory remembers card or list view per device; unreadable storage falls back to list. */
export function readWorkbenchLayout(storage?: Pick<Storage, "getItem">): WorkbenchLayout {
  try { return storage?.getItem(LAYOUT_STORAGE_KEY) === "grid" ? "grid" : "list"; } catch { return "list"; }
}

function storeWorkbenchLayout(layout: WorkbenchLayout) {
  try { window.localStorage.setItem(LAYOUT_STORAGE_KEY, layout); } catch { /* the in-memory choice still applies */ }
}

interface WorkbenchTool {
  icon: ReactNode;
  name: string;
  summary: string;
  /** Live one-liner so the index answers the common question without a click. */
  status: string;
}

export function WorkbenchIndex({
  view,
  assetStatus,
  onOpen,
  syntheticPerformerStatus,
}: {
  view: WorkbenchIndexView;
  assetStatus: string;
  onOpen: (view: WorkbenchView) => void;
  syntheticPerformerStatus: string;
}) {
  const t = useUiText();
  const copy = t.workbenchIndex;
  const tools: Record<WorkbenchToolView, WorkbenchTool> = {
    "fba-capacity": { icon: <Warehouse size={18} />, name: t.fbaCapacity.title, summary: t.fbaCapacity.subtitle, status: "" },
    "vietnam-settings": { icon: <SlidersHorizontal size={18} />, name: t.vietnamSettings.title, summary: t.vietnamSettings.subtitle, status: "" },
    "amazon-v2-settings": { icon: <CalendarDays size={18} />, name: t.amazonV2Settings.title, summary: t.amazonV2Settings.subtitle, status: "" },
    "synthetic-performer": {
      icon: <Tag size={18} />,
      name: copy.tools.syntheticPerformer.name,
      summary: copy.tools.syntheticPerformer.summary,
      status: syntheticPerformerStatus,
    },
    "input-assets": {
      icon: <FolderTree size={18} />,
      name: copy.tools.inputAssets.name,
      summary: copy.tools.inputAssets.summary,
      status: assetStatus,
    },
  };
  const views: WorkbenchIndexView[] = ["tasks", "tools"];
  const shown = workbenchTools(view);
  const [layout, setLayout] = useState<WorkbenchLayout>(() => readWorkbenchLayout(window.localStorage));
  const layouts = [
    { id: "grid", label: copy.layouts.grid, icon: <Grid2X2 size={16} /> },
    { id: "list", label: copy.layouts.list, icon: <List size={16} /> },
  ] as const;

  return (
    <section className="workbench-index">
      <header className="workbench-index-header">
        <h1>{copy.eyebrow}</h1>
        <div className="workbench-index-bar">
        <nav aria-label={copy.eyebrow} className="workspace-subnav workbench-subnav">
          {views.map(item => (
            <button
              aria-current={item === view ? "page" : undefined}
              className={item === view ? "workspace-subnav-item active" : "workspace-subnav-item"}
              key={item}
              onClick={() => onOpen(item)}
              type="button"
            >
              {copy.views[item]}
            </button>
          ))}
        </nav>
        <div className="workbench-layout-toggle" role="group" aria-label={copy.layouts.label}>
          {layouts.map(item => (
            <button
              aria-label={item.label}
              aria-pressed={layout === item.id}
              key={item.id}
              onClick={() => { setLayout(item.id); storeWorkbenchLayout(item.id); }}
              title={item.label}
              type="button"
            >
              {item.icon}
            </button>
          ))}
        </div>
        </div>
      </header>
      <div className="workbench-directory">
        <p className="workbench-index-subtitle">{copy.summaries[view]}</p>
        <div className="workbench-tool-grid" data-layout={layout}>
          {shown.map((id) => {
            const tool = tools[id];
            return (
              <button
                className="workbench-tool-card"
                key={id}
                onClick={() => onOpen(id)}
                type="button"
              >
                <span className="workbench-tool-icon" aria-hidden="true">{tool.icon}</span>
                <span className="workbench-tool-body">
                  <span className="workbench-tool-name">{tool.name}</span>
                  <span className="workbench-tool-summary">{tool.summary}</span>
                </span>
                {tool.status ? <span className="workbench-tool-status">{tool.status}</span> : null}
                <ChevronRight aria-hidden className="workbench-tool-chevron" size={16} />
              </button>
            );
          })}
        </div>
      </div>
    </section>
  );
}
