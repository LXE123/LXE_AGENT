import { useSyncExternalStore } from "react";
import type { FileApplication, FileFailure, FileMetadata, SessionFileRef } from "@lxe/desktop-protocol";
import { failureOf, filesApi } from "./api";
export const fileRefKey = (file: SessionFileRef) => JSON.stringify([file.session_id, file.kind, "path" in file ? file.path : file.id]);
interface Snapshot { apps: FileApplication[]; loaded: boolean; error?: FileFailure; metadata?: FileMetadata; previewError?: FileFailure; sourceError?: FileFailure }
interface Entry { disposed?: boolean; refreshApps?: boolean; value: Snapshot; listeners: Set<() => void>; appsPending?: Promise<void>; statPending?: Promise<FileMetadata>; appsGeneration: number; statGeneration: number; expires: number; checked: number }
const entries = new Map<string, Entry>();
function entry(file: SessionFileRef) {
  const key = fileRefKey(file);
  let shared = entries.get(key);
  if (!shared) {
    shared = { value: { apps: [], loaded: false }, listeners: new Set(), appsGeneration: 0, statGeneration: 0, expires: 0, checked: 0 };
    entries.set(key, shared);
    if (entries.size > 256) for (const [id, item] of entries) { if (entries.size <= 256) break; if (id !== key && !item.listeners.size && !item.appsPending && !item.statPending) entries.delete(id); }
  }
  return shared;
}
function publish(shared: Entry, patch: Partial<Snapshot>) { shared.value = { ...shared.value, ...patch }; shared.listeners.forEach(callback => callback()); }
function invalidateApps(shared: Entry) { shared.appsGeneration++; shared.appsPending = undefined; shared.expires = 0; shared.refreshApps = true; publish(shared, { apps: [], loaded: false, error: undefined }); }
const availabilityError = (failure: FileFailure) => failure.kind !== "unknown";
export function reportFileFailure(file: SessionFileRef, failure: FileFailure, sourceOnly = false) {
  const shared = entry(file);
  if (!availabilityError(failure)) return;
  shared.statGeneration++; shared.statPending = undefined; shared.checked = 0;
  invalidateApps(shared);
  publish(shared, { sourceError: failure, ...((!sourceOnly || shared.value.metadata?.source === "current_file") && shared.value.metadata?.source !== "history" ? { previewError: failure } : {}) });
}
export async function checkFile(file: SessionFileRef, force: boolean | "fresh" = false): Promise<FileMetadata> {
  const shared = entry(file);
  if (force !== true && shared.statPending) return shared.statPending;
  if (!force && shared.checked > Date.now() && shared.value.metadata && !shared.value.previewError) return shared.value.metadata;
  if (force === true) invalidateApps(shared);
  const generation = ++shared.statGeneration;
  const pending = (async () => {
    try {
      const metadata = await filesApi().call({ operation: "stat", input: { ref: file } });
      let sourceError: FileFailure | undefined;
      if (metadata.source === "history") {
        try { await filesApi().call({ operation: "stat", input: { ref: file, original: true } }); }
        catch (error) { sourceError = failureOf(error, "stat"); }
      }
      if (shared.disposed) throw new Error("File state was released");
      if (generation !== shared.statGeneration) return checkFile(file);
      if (generation === shared.statGeneration) {
        const changed = shared.value.sourceError?.kind !== sourceError?.kind;
        if (changed) invalidateApps(shared);
        shared.checked = Date.now() + 700;
        publish(shared, { metadata, previewError: undefined, sourceError });
        // Once resolved, artifact and workspace references share one availability/app cache.
        const owner = [...entries.values()].find(value => value !== shared && value.value.metadata?.key === metadata.key);
        if (owner) {
          shared.statGeneration++; shared.appsGeneration++;
          owner.statGeneration++; owner.statPending = undefined; invalidateApps(owner);
          owner.checked = shared.checked;
          publish(owner, { metadata, previewError: undefined, sourceError });
          for (const [key, value] of entries) if (value === shared) entries.set(key, owner);
          shared.value = owner.value; shared.listeners.forEach(callback => callback());
        }
      }
      return metadata;
    } catch (error) {
      if (shared.disposed) throw new Error("File state was released");
      if (generation !== shared.statGeneration) return checkFile(file);
      if (generation === shared.statGeneration) {
        const failure = failureOf(error, "stat");
        if (availabilityError(failure)) invalidateApps(shared);
        publish(shared, { previewError: failure, ...(availabilityError(failure) ? { sourceError: failure } : {}) });
      }
      throw error;
    } finally { if (generation === shared.statGeneration) shared.statPending = undefined; }
  })();
  shared.statPending = pending;
  return pending;
}
export async function loadFileApplications(file: SessionFileRef, force = false) {
  const shared = entry(file);
  if (!force && shared.appsPending) return shared.appsPending;
  if (!force && shared.expires > Date.now()) return;
  if (shared.value.sourceError?.kind === "not_found" && !force) return;
  const generation = ++shared.appsGeneration;
  shared.appsPending = filesApi().call({ operation: "applications", input: { ref: file, ...(force || shared.refreshApps ? { refresh: true } : {}) } }).then(apps => {
    if (generation !== shared.appsGeneration) return;
    shared.refreshApps = false; shared.expires = Date.now() + 30000; publish(shared, { apps, loaded: true, error: undefined, sourceError: undefined });
  }, error => {
    if (generation !== shared.appsGeneration) return;
    const failure = failureOf(error, "applications");
    if (availabilityError(failure)) reportFileFailure(file, failure, true);
    publish(shared, { apps: [], loaded: true, error: failure });
  }).finally(() => { if (generation === shared.appsGeneration) shared.appsPending = undefined; });
  return shared.appsPending;
}
export const fileSnapshot = (file: SessionFileRef) => entry(file).value;
export function useFileApplications(file: SessionFileRef) {
  const shared = entry(file);
  const snapshot = useSyncExternalStore(callback => { shared.listeners.add(callback); return () => { shared.listeners.delete(callback); }; }, () => shared.value);
  return { ...snapshot, load: (force = false) => loadFileApplications(file, force), check: (force: boolean | "fresh" = false) => checkFile(file, force) };
}
export function forgetFileSession(session: string) { for (const [key, value] of entries) if (JSON.parse(key)[0] === session) { value.disposed = true; value.statGeneration++; value.appsGeneration++; entries.delete(key); } }
