import { forwardRef, type ComponentProps } from "react";
import "./primitives.css";
import { Button } from "./base/button";

type IconButtonProps = ComponentProps<"button"> & { label: string };

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, className = "", type = "button", title = label, ...props }, ref,
) {
  return <Button {...props} variant="ghost" size="icon-sm" ref={ref} type={type} title={title} aria-label={label} className={`lxe-icon-button ${className}`} />;
});
