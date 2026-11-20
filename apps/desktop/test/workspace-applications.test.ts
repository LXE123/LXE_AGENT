import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApplicationResolver, type ResolvedApp } from '../src/main/workspace-apps/resolver';
import { WorkspaceApplications } from '../src/main/workspace-apps/service';
import { externalEnvironment, launchArgs, launchDetached, run } from '../src/main/workspace-apps/process';
import { readRegistry } from '../src/main/workspace-apps/registry';
const roots: string[] = [];
async function root() { const path = await mkdtemp(join(tmpdir(),'lxe-workspace-app-')); roots.push(path); return path; }
afterEach(async () => { await Promise.all(roots.splice(0).map(p => rm(p,{recursive:true,force:true}))); });
test('macOS checks known bundle names, ignores absent apps and keeps ordered deduplicated results', async () => {
  const path=await root(); await mkdir(join(path,'Visual Studio Code.app')); await mkdir(join(path,'Cursor.app'));
  const resolver=new ApplicationResolver({platform:'darwin', applicationRoots:[path,path], execute:async()=>'/Library/Developer/CommandLineTools'});
  const apps=await resolver.all();
  expect([...apps.keys()]).toEqual(['finder','cursor','vscode','terminal']);
  expect(apps.get('vscode')?.launch).toEqual({kind:'argv',command:'/usr/bin/open',args:['-a',join(path,'Visual Studio Code.app')]});
});
test('Windows verifies registry, versioned installs, bundled GitHub CLI and PATH launchers', async () => {
  const path=await root(), code=join(path,'Code.exe'), git=join(path,'Git','git-bash.exe');
  await mkdir(join(path,'Git')); await writeFile(code,''); await writeFile(git,''); await writeFile(join(path,'wt.EXE'),'');
  for (const version of ['2024.1.9','2024.1.10']) { await mkdir(join(path,'JetBrains','PyCharm '+version,'bin'),{recursive:true}); await writeFile(join(path,'JetBrains','PyCharm '+version,'bin','pycharm64.exe'),''); }
  const gh=join(path,'GitHubDesktop','app-3.4.1'); await mkdir(join(gh,'resources','app'),{recursive:true}); await writeFile(join(gh,'GitHubDesktop.exe'),''); await writeFile(join(gh,'resources','app','cli.js'),'');
  let queries=0;
  const resolver=new ApplicationResolver({platform:'win32',env:{LOCALAPPDATA:path,ProgramFiles:path,SystemRoot:path,PATH:path,PATHEXT:'.EXE'},registry:async()=>{queries++;return {appPaths:{'code.exe':code,'cursor.exe':join(path,'missing.exe')},records:[{displayName:'Git version 2.45',installLocation:join(path,'Git')}]};}});
  const apps=await resolver.all(); expect(queries).toBe(1);
  expect(apps.has('cursor')).toBe(false); expect(apps.get('vscode')?.required).toContain(code);
  expect(apps.get('pycharm')?.required[0]).toContain('2024.1.10');
  expect(apps.get('github')?.required).toHaveLength(2);
  expect(apps.get('windowsterminal')?.launch).toMatchObject({args:['-d']});
  expect(apps.get('gitbash')?.launch).toMatchObject({args:['--cd={path}']});
});
test('registry command uses encoded fixed script and preserves malformed/failed query diagnostics', async () => {
  await expect(readRegistry(async()=>{throw new Error('Access denied: registry fixture');})).rejects.toThrow('Access denied: registry fixture');
  await expect(readRegistry(async()=>'{"appPaths":{},"records":[{}]}')).rejects.toThrow('Invalid application registry entries');
  await readRegistry(async(_file,args)=>{expect(args[args.length-2]).toBe('-EncodedCommand');return '{"appPaths":{},"records":[]}';});
});
test('discovery caches and coalesces reads, reports failure and permits retry; icon errors remain nonfatal', async () => {
  let calls=0, fail=true;
  const resolver=new ApplicationResolver(); resolver.all=async()=>{calls++;if(fail)throw new Error('probe EACCES');return new Map([['finder',{id:'finder',name:'Finder',launch:{kind:'shell-open'},required:[],iconPath:'/fixture/Finder.app'}]]);};
  const service=new WorkspaceApplications({resolver:()=>resolver,openPath:async()=>'',icon:async()=>{throw new Error('icon fixture failure');}});
  await expect(service.list()).rejects.toThrow('probe EACCES'); fail=false;
  const [a,b]=await Promise.all([service.list(),service.list()]); expect(calls).toBe(2);expect(a).toEqual(b);expect(a[0]?.icon).toBeNull();
  await service.list();expect(calls).toBe(2);
  await service.list({refresh:true});expect(calls).toBe(3);
});
test('opening validates target/ID, serializes launches, captures directory, refreshes missing launcher once', async () => {
  const path=await root(), executable=join(path,'Code.exe'); await writeFile(executable,'');
  const entry:ResolvedApp={id:'vscode',name:'VS Code',launch:{kind:'argv',command:executable,args:[]},required:[executable]};
  let resolveCalls=0, release:()=>void=()=>{};
  const resolver=new ApplicationResolver();resolver.all=async()=>new Map([['vscode',entry]]);resolver.resolve=async()=>{resolveCalls++;return null;};
  const launched:string[]=[];
  const service=new WorkspaceApplications({resolver:()=>resolver,icon:async()=>'',openPath:async path=>{launched.push(path);await new Promise<void>(r=>release=r);return '';}});
  const opening=service.open(path);await expect(service.open(path)).rejects.toThrow('already in progress');release();await opening;
  expect(launched).toHaveLength(1);
  await expect(service.open('relative')).rejects.toThrow('absolute');await expect(service.open(executable)).rejects.toThrow('not a directory');await expect(service.open(path,'arbitrary-command')).rejects.toThrow('Unknown');
  await service.list();await rm(executable);await expect(service.open(path,'vscode')).rejects.toThrow('ENOENT');expect(resolveCalls).toBe(1);expect(await service.list()).toEqual([]);
});
test('argument substitution and launch environment preserve literal paths and remove credentials', async () => {
  const path='中文 folder & $() "quoted"';expect(launchArgs(['--cd={path}'],path)).toEqual(['--cd='+path]);expect(launchArgs(['-d'],path)).toEqual(['-d',path]);
  expect(externalEnvironment({PATH:'/bin',HOME:'/user',API_KEY:'secret',aGeNt_Db:'db',ELECTRON_RUN_AS_NODE:'1',NODE_OPTIONS:'--require bad',safe:'yes'})).toEqual({PATH:'/bin',HOME:'/user',safe:'yes'});
  await expect(run(process.execPath,['-e','process.stderr.write("native fixture failure");process.exit(7)'])).rejects.toThrow('native fixture failure');
  await expect(launchDetached({kind:'argv',command:join(await root(),'missing'),args:[]},path,100)).rejects.toThrow('missing');
  await expect(launchDetached({kind:'argv',command:process.execPath,args:['-e','process.exit(9)']},path,1000)).rejects.toThrow('code 9');
});

test('launcher is re-resolved only once and a second disappearance evicts the entry', async () => {
  const directory = await root();
  const entry: ResolvedApp = { id: 'vscode', name: 'VS Code', launch: { kind: 'argv', command: '/fixture/code', args: [] }, required: [] };
  const resolver = new ApplicationResolver();
  let probes = 0, launches = 0;
  resolver.all = async () => new Map([['vscode', entry]]);
  resolver.resolve = async () => { probes++; return entry; };
  const service = new WorkspaceApplications({ resolver: () => resolver, icon: async () => '', openPath: async () => '', launch: async () => {
    launches++; throw Object.assign(new Error('spawn fixture ENOENT'), { code: 'ENOENT' });
  } });
  await expect(service.open(directory, 'vscode')).rejects.toThrow('spawn fixture ENOENT');
  expect(probes).toBe(1); expect(launches).toBe(2); expect(await service.list()).toEqual([]);
});
