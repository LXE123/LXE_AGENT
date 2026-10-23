import { createHash, randomUUID } from "node:crypto";
import { createOfficeConverter, type OfficeConverter } from "./office-kit";
import { mkdir, readFile, writeFile, rename, rm, readdir, stat, utimes } from "node:fs/promises";
import { readLimited } from "./paths";
import { join } from "node:path";

interface Result { bytes: Uint8Array; missingFonts: string[] }
interface Task { controller: AbortController; consumers: Set<symbol>; result: Promise<Result> }
export class OfficePreviewCache {
  private tail: Promise<unknown> = Promise.resolve();
  private initialized = false;
  private leases = new Map<string, number>();
  private tasks = new Map<string, Task>();
  private converter: Promise<OfficeConverter> | undefined;
  private disposed = false;
  constructor(private root: string, private kitCliPath: string, private createConverter = createOfficeConverter) {}
  private getConverter(): Promise<OfficeConverter> {
    return this.converter ??= this.createConverter(this.kitCliPath).catch(error => { this.converter = undefined; throw error; });
  }
  async get(bytes: Uint8Array, extension: string, signal: AbortSignal): Promise<Result & { release(): void }> {
    signal.throwIfAborted();
    if (this.disposed) throw new Error("Office preview cache is disposed");
    const key = createHash("sha256").update("libreoffice-kit-0.1.5-api-v1\0" + extension).update(bytes).digest("hex");
    let task = this.tasks.get(key);
    if (task?.controller.signal.aborted) task = undefined;
    if (!task) {
      const controller = new AbortController();
      const created: Task = { controller, consumers: new Set(), result: Promise.resolve({ bytes: new Uint8Array(), missingFonts: [] }) };
      created.result = this.tail.catch(() => {}).then(() => this.convertOne(key, bytes, extension, controller.signal));
      this.tail = created.result;
      this.tasks.set(key, created);
      void created.result.finally(() => { if (this.tasks.get(key) === created) this.tasks.delete(key); }).catch(() => {});
      task = created;
    }
    const retained = task, owner = Symbol();
    retained.consumers.add(owner);
    return new Promise((resolve, reject) => {
      let done = false;
      const finish = () => {
        if (done) return false;
        done = true; signal.removeEventListener("abort", abort); retained.consumers.delete(owner);
        if (!retained.consumers.size) retained.controller.abort();
        return true;
      };
      const abort = () => { if (finish()) reject(signal.reason ?? new Error("Preview cancelled")); };
      signal.addEventListener("abort", abort, { once: true });
      retained.result.then(value => { if (finish()) {
        this.leases.set(key, (this.leases.get(key) ?? 0) + 1); let released = false;
        resolve({ ...value, release: () => { if (released) return; released = true; const count = (this.leases.get(key) ?? 1) - 1; if (count) this.leases.set(key, count); else this.leases.delete(key); } });
      } }, error => { if (finish()) reject(error); });
      if (signal.aborted) abort();
    });
  }
  private async convertOne(key: string, bytes: Uint8Array, extension: string, signal: AbortSignal): Promise<Result> {
    signal.throwIfAborted();
    await mkdir(this.root, { recursive: true });
    if (!this.initialized) { await this.clean(""); this.initialized = true; }
    const target = join(this.root, `${key}.pdf`), info = join(this.root, `${key}.json`);
    try {
      const pdf = await readLimited(target, 50 * 1024 * 1024), fonts: unknown = JSON.parse(await readFile(info, "utf8"));
      if (!pdf.subarray(0, 5).equals(Buffer.from("%PDF-")) || !Array.isArray(fonts) || fonts.some(x => typeof x !== "string")) throw new Error("Invalid preview cache");
      await utimes(target, new Date(), new Date());
      return { bytes: pdf, missingFonts: fonts };
    } catch (error) {
      // Only disposable cache data is removed. Source documents are never outputs.
      await Promise.all([rm(target, { force: true }), rm(info, { force: true })]);
    }
    signal.throwIfAborted();
    const id = randomUUID(), input = join(this.root, `${id}${extension}`), output = join(this.root, `${id}.pdf`);
    try {
      await writeFile(input, bytes, { flag: "wx" });
      const converter = await this.getConverter();
      signal.throwIfAborted();
      const { missingFonts } = await converter.render({ inputPath: input, outputPath: output }, signal);
      signal.throwIfAborted();
      const pdf = await readLimited(output, 50 * 1024 * 1024);
      if (!pdf.subarray(0, 5).equals(Buffer.from("%PDF-"))) throw new Error("Office output is not a PDF");
      await rename(output, target); await writeFile(info, JSON.stringify(missingFonts));
      await this.clean(key);
      return { bytes: pdf, missingFonts };
    } finally { await Promise.all([rm(input, { force: true }), rm(output, { force: true })]); }
  }
  private async clean(keep: string): Promise<void> {
    const files = await Promise.all((await readdir(this.root)).filter(name => /^[a-f0-9]{64}\.pdf$/.test(name)).map(async name => ({ name, ...(await stat(join(this.root, name))) })));
    files.sort((a, b) => b.mtimeMs - a.mtimeMs);
    let total = 0;
    for (const file of files) {
      total += file.size;
      const key = file.name.slice(0, -4);
      if (key !== keep && !this.tasks.has(key) && !this.leases.has(key) && (total > 512 * 1024 * 1024 || Date.now() - file.mtimeMs > 7 * 86400000)) {
        await rm(join(this.root, file.name), { force: true }); await rm(join(this.root, `${key}.json`), { force: true });
      }
    }
  }
  async dispose(): Promise<void> {
    this.disposed = true;
    for (const task of this.tasks.values()) task.controller.abort();
    await this.tail.catch(() => {});
    const converter = await this.converter;
    this.converter = undefined;
    await converter?.dispose();
    this.leases.clear();
  }
}
