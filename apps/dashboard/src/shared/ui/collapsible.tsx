import * as Primitive from "@radix-ui/react-collapsible";
import type { ComponentProps } from "react";
import "./primitives.css";

export const Collapsible = Primitive.Root;
export const CollapsibleTrigger = Primitive.Trigger;

export function CollapsibleContent({ className = "", ...props }: ComponentProps<typeof Primitive.Content>) {
  return <Primitive.Content {...props} className={`lxe-collapsible-content ${className}`} />;
}
