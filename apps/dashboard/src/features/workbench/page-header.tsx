import type { ReactNode } from "react";
import { ArrowLeft } from "lucide-react";
import { useUiText } from "../../shared/i18n";

export function WorkbenchPageHeader({ title, titleId, description, onBack, actions, metadata }: {
  title: string;
  titleId: string;
  description: string;
  onBack: () => void;
  actions?: ReactNode;
  metadata?: ReactNode;
}) {
  const t = useUiText();
  return <header className="workbench-detail-header">
    <button className="workbench-back" onClick={onBack} type="button">
      <ArrowLeft size={14} aria-hidden />{t.workbenchIndex.back}
    </button>
    <div className="workbench-detail-heading">
      <h1 id={titleId}>{title}</h1>
      {actions ? <div className="workbench-detail-actions">{actions}</div> : null}
    </div>
    <p className="workbench-detail-description">{description}</p>
    {metadata}
  </header>;
}
