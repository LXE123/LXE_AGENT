import { File } from "lucide-react";
import csvIcon from "../../assets/file-types/csv.png";
import htmlIcon from "../../assets/file-types/html.png";
import xlsIcon from "../../assets/file-types/xls.png";
import xlsxIcon from "../../assets/file-types/xlsx.png";

/* Use an icon only for the exact extension; an unknown type keeps the generic file icon. */
export const FILE_TYPE_ICONS: Record<string, string> = {
  CSV: csvIcon,
  HTML: htmlIcon,
  XLS: xlsIcon,
  XLSX: xlsxIcon,
};

export function attachmentSuffix(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 && dot < name.length - 1 ? name.slice(dot + 1).toUpperCase() : "";
}

export function FileAttachmentIcon({ name }: { name: string }) {
  const icon = FILE_TYPE_ICONS[attachmentSuffix(name)];
  return <span className="input-attachment-file-icon" aria-hidden="true">
    {icon ? <img src={icon} alt="" draggable={false} /> : <File size={28} />}
  </span>;
}

export function FileAttachmentInfo({ name }: { name: string }) {
  const suffix = attachmentSuffix(name);
  return <span className="input-attachment-info">
    <span>{name}</span>
    {suffix ? <span className="input-attachment-suffix">{suffix}</span> : null}
  </span>;
}
