/** Confirm only work actually seen by the user; fence before the final snapshot. */
export async function prepareUpdate(ports:{
 snapshot():string[];
 confirm(tasks:readonly string[]):Promise<boolean>;
 fence():()=>void;
 settle():Promise<void>;
}):Promise<(()=>void)|undefined> {
 for(;;){
  const approved=new Set(ports.snapshot());
  if(!await ports.confirm([...approved]))return;
  const unlock=ports.fence();
  try{
   await ports.settle();
   if(ports.snapshot().some(task=>!approved.has(task))){unlock();continue;}
   return unlock;
  }catch(error){unlock();throw error;}
 }
}
