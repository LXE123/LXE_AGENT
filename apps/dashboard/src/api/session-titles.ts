import type { SessionPayload } from "@lxe/desktop-protocol";

type Title = Pick<SessionPayload, "title" | "title_version" | "title_source">;
/** Accepted title versions survive stale list/detail requests, including across selection changes. */
const titles = new Map<string, Title>();
export function projectSessionTitle(session: SessionPayload): SessionPayload {
  const previous = titles.get(session.session_id);
  if (previous && (previous.title_version ?? 0) > (session.title_version ?? 0)) return { ...session, ...previous };
  titles.set(session.session_id, { title: session.title, title_version: session.title_version, title_source: session.title_source });
  return session;
}
export function clearSessionTitles(): void { titles.clear(); }
export function projectSessionData<T>(data: T): T {
  if (!data || typeof data !== "object") return data;
  if ("session_id" in data && "title" in data) return projectSessionTitle(data as unknown as SessionPayload) as T;
  if ("session" in data && data.session && typeof data.session === "object") return { ...data, session: projectSessionTitle(data.session as SessionPayload) };
  if ("pages" in data && Array.isArray(data.pages)) return { ...data, pages: data.pages.map(projectSessionData) };
  if ("items" in data && Array.isArray(data.items)) return { ...data, items: data.items.map(projectSessionData) };
  return data;
}
