import type { WorkspaceApplication } from '@lxe/desktop-protocol';
import { workspaceDirectory } from '../workspace-directory';
import { catalog } from './catalog';
import { ApplicationResolver, present, type ResolvedApp, type ResolverOptions } from './resolver';
import { diagnostic, launchDetached, missing } from './process';
interface Dependencies {
  openPath(path: string): Promise<string>;
  icon(path: string): Promise<string>;
  resolver?: () => ApplicationResolver;
  resolverOptions?: ResolverOptions;
  launch?: typeof launchDetached;
}
export class WorkspaceApplications {
  private resolved: Promise<Map<string, ResolvedApp>> | undefined;
  private icons = new Map<string, Promise<string | null>>();
  private opening = false;
  constructor(private readonly dependencies: Dependencies) {}
  private resolver() { return this.dependencies.resolver?.() ?? new ApplicationResolver(this.dependencies.resolverOptions); }
  private apps() {
    if (!this.resolved) {
      const pending = this.resolver().all(); this.resolved = pending;
      void pending.catch(() => { if (this.resolved === pending) this.resolved = undefined; });
    }
    return this.resolved;
  }
  async list(input: unknown = {}): Promise<WorkspaceApplication[]> {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => key !== 'refresh')
      || ('refresh' in input && typeof input.refresh !== 'boolean')) throw new Error('Invalid workspace applications query');
    if ('refresh' in input && input.refresh && !this.opening) { this.resolved = undefined; this.icons.clear(); }
    try {
      const apps = await this.apps();
      return await Promise.all([...apps.values()].map(async entry => {
        let image = this.icons.get(entry.id);
        if (!image) {
          image = (async () => {
            if (!entry.iconPath) return null;
            let timer: ReturnType<typeof setTimeout> | undefined;
            try {
              return await Promise.race([this.dependencies.icon(entry.iconPath), new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new Error(`Application icon extraction timed out: ${entry.iconPath}`)), 10000);
              })]);
            } catch (error) { console.warn('Workspace application icon:', diagnostic(error)); return null; }
            finally { clearTimeout(timer); }
          })();
          this.icons.set(entry.id, image);
        }
        return { id: entry.id, name: entry.name, icon: await image };
      }));
    } catch (error) { throw new Error(diagnostic(error), { cause: error }); }
  }
  async open(directory: unknown, applicationId?: unknown): Promise<void> {
    if (this.opening) throw new Error('A workspace application launch is already in progress');
    this.opening = true;
    try {
      const path = workspaceDirectory(directory);
      if (applicationId === undefined) { const error = await this.dependencies.openPath(path); if (error) throw new Error(error); return; }
      if (typeof applicationId !== 'string' || !catalog.some(app => app.id === applicationId)) throw new Error('Unknown workspace application');
      const apps = await this.apps();
      const entry = apps.get(applicationId);
      if (!entry) throw new Error(`Workspace application is unavailable: ${applicationId}`);
      try { await this.launch(entry, path); }
      catch (error) {
        if (!missing(error)) throw error;
        const fresh = await this.resolver().resolve(catalog.find(app => app.id === applicationId)!);
        this.icons.delete(applicationId);
        if (!fresh) { apps.delete(applicationId); throw error; }
        apps.set(applicationId, fresh);
        try { await this.launch(fresh, path); }
        catch (retryError) {
          if (missing(retryError)) apps.delete(applicationId);
          throw retryError;
        }
      }
    } catch (error) { throw new Error(diagnostic(error), { cause: error }); }
    finally { this.opening = false; }
  }
  private async launch(entry: ResolvedApp, path: string): Promise<void> {
    for (const file of entry.required) await present(file);
    if (entry.launch.kind === 'shell-open') { const error = await this.dependencies.openPath(path); if (error) throw new Error(error); return; }
    try { await (this.dependencies.launch ?? launchDetached)(entry.launch, path); }
    catch (error) {
      if (missing(error) || !entry.fallback || entry.fallback.kind !== 'argv') throw error;
      try { await (this.dependencies.launch ?? launchDetached)(entry.fallback, path); }
      catch (fallback) { throw new Error(`${diagnostic(error)}\nFallback: ${diagnostic(fallback)}`, { cause: fallback }); }
    }
  }
}
