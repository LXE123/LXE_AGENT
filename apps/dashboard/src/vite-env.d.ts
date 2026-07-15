/// <reference types="vite/client" />

import type { LxeDesktopBridge } from "@lxe/desktop-protocol";

declare global {
  interface Window {
    lxe?: LxeDesktopBridge;
  }
}

export {};
