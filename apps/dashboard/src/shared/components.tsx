import { Inbox } from "lucide-react";

import { formatNumber } from "./format";

export function EmptyState({ label }: { label: string }) {
  return (
    <div className="empty-state">
      <span className="empty-state-icon"><Inbox size={18} /></span>
      <span>{label}</span>
    </div>
  );
}

export function FailureCount({ value }: { value: number }) {
  if (value <= 0) {
    return <span className="usage-num-zero">0</span>;
  }
  return <span className="usage-num-danger">{formatNumber(value)}</span>;
}
