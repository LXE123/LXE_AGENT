import { ChevronRight, FolderTree, Tag, SlidersHorizontal, CalendarDays, Warehouse } from "lucide-react";
import type { ReactNode } from "react";
import { workbenchTools, type WorkbenchIndexView, type WorkbenchView, type WorkbenchToolView } from "../../shared/navigation";
import { useUiText } from "../../shared/i18n";

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

  return (
    <section className="workbench-index">
      <header className="workbench-index-header">
        <h1>{copy.eyebrow}</h1>
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
      </header>
      <div className="workbench-directory">
        <p className="workbench-index-subtitle">{copy.summaries[view]}</p>
        <div className="workbench-tool-grid">
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
