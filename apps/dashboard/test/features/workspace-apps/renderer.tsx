import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { WorkspaceControl } from '../../../src/features/sessions/workspaces';
import { FileTree } from '../../../src/features/file-preview/FileTree';
import { readingState } from '../../../src/features/file-preview/reading-state';
import { workspaceApplications } from '../../../src/features/workspace-apps/state';
import { setFileBridgeForTests } from '../../../src/features/file-preview/api';
import { BrowserPanel } from '../../../src/features/file-preview/ToolPanels';
import { emptyWorkspace } from '../../../src/features/sessions/workspace-state';
import '../../../src/styles.css';
import '../../../src/features/file-preview/sidebar.css';
const native = (window as any).native;
let apps=[{id:'finder',name:'Finder',icon:null},{id:'vscode',name:'VS Code',icon:null},{id:'terminal',name:'Terminal',icon:null}];
let failure='', queryError='', release:()=>void=()=>{}, hold=false;
const calls:any[]=[];
window.lxe={...native,desktop:{...native.desktop,platform:'darwin',getWorkspaceApplications:async()=>{if(queryError)throw new Error(queryError);return apps;},openWorkspace:async(directory:string,id?:string)=>{calls.push({directory,id});if(hold)await new Promise<void>(r=>release=r);if(failure)throw new Error(failure);}},tools:{call:async(call:any)=>{calls.push(call);return native.tools.call(call);},subscribe:native.tools.subscribe}};
setFileBridgeForTests({call:async(call:any)=>call.operation==='list'?{rootPath:'/first',entries:[],next:null}:{version:'1'}} as any);
function Fixture(){
 const [path,setPath]=useState('/first');
 (window as any).fixture={calls, native, setPath, apps:(value:any)=>{apps=value;return workspaceApplications.load(true);}, fail:(value:string)=>failure=value, query:(value:string)=>{queryError=value;return workspaceApplications.load(true);}, hold:(value:boolean)=>hold=value, release:()=>release()};
 return <div style={{padding:20}}><div id="new"><WorkspaceControl workspaceId={"workspace:" + path} directory={path} workspaces={[{...emptyWorkspace(path),workspace_id:"workspace:" + path}]} defaultDirectory="/first" editable disabled={false} onChange={id=>setPath(id.slice("workspace:".length))} onChoose={async()=>{}} /></div><div id="existing"><WorkspaceControl workspaceId={"workspace:" + path} directory={path} workspaces={[{...emptyWorkspace(path),workspace_id:"workspace:" + path}]} defaultDirectory="/first" editable={false} disabled={false} onChange={id=>setPath(id.slice("workspace:".length))} onChoose={async()=>{}} /></div><div style={{display:'flex',height:420}}><FileTree session="a" state={readingState('a','tree')} open={()=>{}}/><BrowserPanel sessionId="a" tab={{key:'test',name:'Browser',kind:'browser'}} /></div></div>;
}
createRoot(document.getElementById('root')!).render(<Fixture/>);
