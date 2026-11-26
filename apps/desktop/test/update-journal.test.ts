import {test,expect} from "bun:test";
import {mkdtempSync,rmSync,readFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {UpdateJournal} from "../src/main/updates/update-journal";
test("interrupted installation is visible on next launch and success clears attempt",()=>{
 const dir=mkdtempSync(join(tmpdir(),"lxe-update-journal-"));const path=join(dir,"attempt.json");
 try{const journal=new UpdateJournal(path);journal.start("0.2.18","one");
 journal.error(new Error("spawn failed https://cos.test/a?signature=secret"));
 expect(readFileSync(path,"utf8")).not.toContain("signature=secret");
 expect(new UpdateJournal(path).previous("0.2.17")).toContain("spawn failed");
 expect(journal.previous("0.2.18","other-build")).toContain("spawn failed");
 expect(journal.previous("0.2.18","one")).toContain("已成功更新");
 expect(journal.previous("0.2.18","one")).toBeUndefined();
 }finally{rmSync(dir,{recursive:true});}
});
