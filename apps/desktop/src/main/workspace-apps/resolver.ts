// Platform locators adapted from DeepSeek Harness 639ed01539; see LICENSE.
import { access, lstat, readdir, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, delimiter } from 'node:path';
import { catalog, type CatalogApp, type Launch, type Locator } from './catalog';
import { readRegistry, type RegistryView } from './registry';
import { missing, run } from './process';
export interface ResolvedApp { id: string; name: string; launch: Launch; fallback?: Launch; iconPath?: string | undefined; required: string[] }
export interface ResolverOptions {
  platform?: NodeJS.Platform; home?: string; env?: NodeJS.ProcessEnv; applicationRoots?: string[];
  execute?: typeof run; registry?: () => Promise<RegistryView>;
}
// Windows app execution aliases (WindowsApps\wt.exe) are reparse points that
// stat cannot open but CreateProcess launches; lstat still reads them.
async function executionAlias(path: string): Promise<boolean> {
  return process.platform === 'win32' && await lstat(path).then(info => info.isSymbolicLink(), () => false);
}
export async function exists(path: string, directory = false): Promise<boolean> {
  try { const info = await stat(path); return directory ? info.isDirectory() : info.isFile(); }
  catch (error) { if (missing(error)) return false; if (!directory && await executionAlias(path)) return true; throw error; }
}
/** Throws the actual stat error unless the path exists or is an execution alias. */
export async function present(path: string): Promise<void> {
  try { await stat(path); } catch (error) { if (missing(error) || !await executionAlias(path)) throw error; }
}
async function directories(path: string): Promise<string[]> {
  try { return await readdir(path); } catch (error) { if (missing(error)) return []; throw error; }
}
export class ApplicationResolver {
  readonly platform: NodeJS.Platform;
  private readonly env: NodeJS.ProcessEnv;
  private readonly home: string;
  private registryValue?: Promise<RegistryView>;
  constructor(private readonly options: ResolverOptions = {}) {
    this.platform = options.platform ?? process.platform; this.env = options.env ?? process.env; this.home = options.home ?? homedir();
  }
  private variable(name: string) { return this.env[name] ?? (this.platform === 'win32' ? Object.entries(this.env).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1] : undefined); }
  expand(value: string): string | null {
    let unset = false;
    const expanded = value.replace(/\$\{([^}]+)\}|%([^%]+)%/g, (_, a, b) => { const v = this.variable(a ?? b); if (v === undefined) unset = true; return v ?? ''; });
    return unset ? null : expanded.startsWith('~/') ? join(this.home, expanded.slice(2)) : expanded;
  }
  private registry(): Promise<RegistryView> { return this.registryValue ??= this.options.registry?.() ?? readRegistry(this.options.execute, this.env); }
  private async executable(name: string): Promise<string | null> {
    const windows = this.platform === 'win32';
    const extensions = windows ? (this.variable('PATHEXT') || '.EXE;.COM').split(';').filter(ext => /^\.(exe|com)$/i.test(ext)) : [''];
    for (const root of (this.variable('PATH') || '').split(windows ? ';' : delimiter).filter(Boolean)) {
      for (const ext of extensions) {
        const path = join(root.replace(/^"|"$/g, ''), name + ext);
        if (await exists(path)) { if (!windows) await access(path, constants.X_OK); return path; }
      }
    }
    return null;
  }
  async resolve(app: CatalogApp): Promise<ResolvedApp | null> {
    const spec = this.platform === 'darwin' || this.platform === 'win32' ? app.platforms[this.platform] : undefined;
    if (!spec) return null;
    for (const locator of spec.locators) {
      const result = await this.locate(locator);
      if (result) return { id: app.id, name: app.name, ...result };
    }
    return null;
  }
  async all(): Promise<Map<string, ResolvedApp>> {
    const entries = await Promise.all(catalog.map(app => this.resolve(app)));
    return new Map(entries.filter((entry): entry is ResolvedApp => !!entry).map(entry => [entry.id, entry]));
  }
  private argv(command: string, args: readonly string[], iconPath = command): Omit<ResolvedApp, 'id'|'name'> {
    return { launch: { kind: 'argv', command, args }, iconPath, required: [command] };
  }
  private async locate(locator: Locator): Promise<Omit<ResolvedApp, 'id'|'name'> | null> {
    switch (locator.kind) {
      case 'fixed': return { launch: locator.launch, iconPath: this.expand(locator.iconPath) ?? undefined, required: [] };
      case 'app': {
        for (const root of this.options.applicationRoots ?? ['/Applications', join(this.home, 'Applications')]) for (const name of locator.fsNames) {
          const path = join(root, name);
          if (await exists(path, true)) return { launch: { kind: 'argv', command: '/usr/bin/open', args: ['-a', path] }, iconPath: path, required: [path] };
        }
        return null;
      }
      case 'xcode': {
        // No active developer directory is a supported absence, not a failed probe.
        const candidates = [this.variable('DEVELOPER_DIR'), '/var/db/xcode_select_link', '/Library/Developer/CommandLineTools', '/Applications/Xcode.app'].filter((path): path is string => !!path);
        if (!(await Promise.all(candidates.map(p => exists(p, true)))).some(Boolean)) return null;
        const developer = (await (this.options.execute ?? run)('/usr/bin/xcode-select', ['-p'])).trim();
        const bundle = dirname(dirname(developer));
        if (!bundle.endsWith('.app') || !await exists(bundle, true)) return null;
        return { launch: { kind: 'argv', command: '/usr/bin/xed', args: [] }, fallback: { kind: 'argv', command: '/usr/bin/open', args: ['-a', bundle] }, iconPath: bundle, required: [bundle] };
      }
      case 'cli': { const command = await this.executable(locator.name); return command ? this.argv(command, locator.args) : null; }
      case 'file': {
        for (const raw of locator.candidates) { const path = this.expand(raw); if (path && await exists(path)) return this.argv(path, locator.args); }
        return null;
      }
      case 'app-paths': {
        const raw = (await this.registry()).appPaths[locator.exe.toLowerCase()];
        const path = raw && this.expand(raw.replace(/^"|"$/g, ''));
        return path && await exists(path) ? this.argv(path, locator.args) : null;
      }
      case 'install-record': {
        for (const record of (await this.registry()).records) {
          if (!record.displayName.startsWith(locator.displayNamePrefix)) continue;
          const location = record.installLocation && this.expand(record.installLocation.replace(/^"|"$/g, ''));
          const icon = record.displayIcon && this.expand(record.displayIcon.replace(/,-?\d+$/, '').replace(/^"|"$/g, '').trim());
          const candidates = [location && locator.relativeLauncher ? join(location, locator.relativeLauncher) : null, icon];
          for (const path of candidates) if (path && path.toLowerCase().endsWith('.exe') && await exists(path)) return this.argv(path, locator.args);
        }
        return null;
      }
      case 'scan': case 'github-desktop': {
        const root = this.expand(locator.root); if (!root) return null;
        const prefix = locator.kind === 'scan' ? locator.namePrefix : 'app-';
        const versions = (await directories(root)).filter(name => name.startsWith(prefix)).sort((a,b) => b.localeCompare(a,'en',{numeric:true}));
        for (const version of versions) {
          const folder = join(root, version);
          if (locator.kind === 'scan') { const file = join(folder, locator.relativeLauncher); if (await exists(file)) return this.argv(file, locator.args); }
          else {
            const command = join(folder, 'GitHubDesktop.exe'), cli = join(folder, 'resources', 'app', 'cli.js');
            if (await exists(command) && await exists(cli)) return { launch: { kind: 'argv', command, args: [cli,'open'], env: { ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true }, iconPath: command, required: [command,cli] };
          }
        }
        return null;
      }
    }
  }
}
