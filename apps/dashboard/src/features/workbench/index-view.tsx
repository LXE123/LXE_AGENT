import { ChevronRight, FolderTree, Tag } from "lucide-react";
import type { ReactNode } from "react";
import type { WorkbenchView } from "../../shared/navigation";
import { useUiText } from "../../shared/i18n";

interface WorkbenchTool {
  id: Exclude<WorkbenchView, "index">;
  icon: ReactNode;
  name: string;
  summary: string;
  /** Live one-liner so the index answers the common question without a click. */
  status: string;
}

export function WorkbenchIndex({
  assetStatus,
  onOpen,
  syntheticPerformerStatus,
}: {
  assetStatus: string;
  onOpen: (view: Exclude<WorkbenchView, "index">) => void;
  syntheticPerformerStatus: string;
}) {
  const t = useUiText();
  const copy = t.workbenchIndex;
  const tools: WorkbenchTool[] = [
    {
      id: "synthetic-performer",
      icon: <Tag size={18} />,
      name: copy.tools.syntheticPerformer.name,
      summary: copy.tools.syntheticPerformer.summary,
      status: syntheticPerformerStatus,
    },
    {
      id: "input-assets",
      icon: <FolderTree size={18} />,
      name: copy.tools.inputAssets.name,
      summary: copy.tools.inputAssets.summary,
      status: assetStatus,
    },
  ];

  return (
    <section className="workbench-index">
      <header className="workbench-index-header">
        <p className="workbench-eyebrow">{copy.eyebrow}</p>
        <h2>{copy.title}</h2>
        <p className="workbench-index-subtitle">{copy.subtitle}</p>
      </header>
      <div className="workbench-tool-grid">
        {tools.map((tool) => (
          <button
            className="workbench-tool-card"
            key={tool.id}
            onClick={() => onOpen(tool.id)}
            type="button"
          >
            <span className="workbench-tool-icon">{tool.icon}</span>
            <span className="workbench-tool-body">
              <span className="workbench-tool-name">{tool.name}</span>
              <span className="workbench-tool-summary">{tool.summary}</span>
              {tool.status ? <span className="workbench-tool-status">{tool.status}</span> : null}
            </span>
            <ChevronRight aria-hidden className="workbench-tool-chevron" size={16} />
          </button>
        ))}
      </div>
    </section>
  );
}
