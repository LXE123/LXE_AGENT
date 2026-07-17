import appLogo from "../../assets/brand/lxe-agent-logo.png";

export interface BrandMarkProps {
  className?: string;
  title?: string;
}

/** The approved LXE Agent application mark shared by every Renderer surface. */
export function BrandMark({ className, title }: BrandMarkProps) {
  return (
    <img
      alt={title || ""}
      aria-hidden={title ? undefined : true}
      className={className}
      draggable={false}
      src={appLogo}
    />
  );
}
