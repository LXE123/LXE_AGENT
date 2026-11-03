import { Collapsible, CollapsibleTrigger, CollapsibleContent as Content } from "./base/collapsible";
import type { ComponentProps } from "react";
import "./primitives.css";

export { Collapsible, CollapsibleTrigger };
export function CollapsibleContent({ className = "", ...props }: ComponentProps<typeof Content>) {
  return <Content {...props} className={`lxe-collapsible-content ${className}`} />;
}
