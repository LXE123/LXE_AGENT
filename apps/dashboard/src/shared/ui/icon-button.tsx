import { forwardRef, type ComponentProps } from "react";
import "./primitives.css";

type IconButtonProps = ComponentProps<"button"> & { label: string };

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, className = "", type = "button", title = label, ...props }, ref,
) {
  return <button {...props} ref={ref} type={type} title={title} aria-label={label} className={`lxe-icon-button ${className}`} />;
});
