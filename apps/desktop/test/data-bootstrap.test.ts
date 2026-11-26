import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { bootstrapUserData } from "../src/main/data/data-bootstrap";
import { DATA_LOCATION_MARKER } from "../src/main/data/data-migration";
import type { DesktopPaths } from "../src/main/paths";

const unusedStorage = async () => {throw new Error("must not read credentials");};
test("multiple legacy sources are shown for selection and cancellation leaves them untouched", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "lxe-data-selection-")));
  try {
    const current=join(root,"current"),previous=join(root,"previous"),dataRoot=join(root,"data");
    for(const install of [current,previous]) {mkdirSync(join(install,"var"),{recursive:true});writeFileSync(join(install,"var","sentinel"),"keep");}
    writeFileSync(join(current,"lxe-legacy-data.ini"),`[LXE]\nappId=test\nprevious=${previous}\n`);
    let offered: string[] = [];
    expect(await bootstrapUserData({projectRoot:current,dataRoot} as DesktopPaths,"test",unusedStorage,async sources => {offered=sources;return undefined;})).toBe(false);
    expect(offered).toEqual([join(current,"var"),join(previous,"var")]);
  } finally {rmSync(root,{recursive:true,force:true});}
});

test("initialized default data does not inspect or merge legacy locations", async () => {
  const root=realpathSync(mkdtempSync(join(tmpdir(),"lxe-data-existing-")));
  try {
    const marker=join(root,DATA_LOCATION_MARKER);mkdirSync(join(root,"migrations"));
    writeFileSync(marker,JSON.stringify({schema:1,status:"complete"}));
    expect(await bootstrapUserData({projectRoot:"missing installation",dataRoot:root} as DesktopPaths,"test",unusedStorage,async () => {throw new Error("must not select again");})).toBe(true);
  } finally {rmSync(root,{recursive:true,force:true});}
});
