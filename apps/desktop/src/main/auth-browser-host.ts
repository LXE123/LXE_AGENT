import { BrowserSessionHost, type BrowserSession } from "./browser-session-host";

export type { BrowserSession as AuthBrowserSession } from "./browser-session-host";

/** Preserve the authentication protocol while sharing only transport and cleanup. */
export class AuthBrowserHost extends BrowserSessionHost {
  constructor(
    createSession: (headless: boolean) => Promise<BrowserSession>,
    idleMs = 180_000,
  ) {
    super(async args => {
      if (typeof args.headless !== "boolean") throw new Error("headless must be boolean");
      if (args.purpose !== undefined) {
        throw new Error("Unsupported browser purpose");
      }
      return createSession(args.headless);
    }, { route: "/v1/auth-browser", environmentPrefix: "LXE_AUTH_BROWSER_HOST", idleMs });
  }
}
