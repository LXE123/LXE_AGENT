import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

// Child processes of the control script can inherit stdout. A per-run marker
// distinguishes their logs from bridge requests even without a trailing newline.
const protocol = process.stdout.write.bind(process.stdout);
const marker = "\x1e" + process.argv[2] + "\x1e";
const input = createInterface({ input: process.stdin, crlfDelay: Infinity })[Symbol.asyncIterator]();
async function receive() {
  const line = await input.next();
  if (line.done) throw new Error("Browser bridge closed its input");
  return JSON.parse(line.value);
}
function send(message) {
  return new Promise((resolve, reject) => protocol(marker + JSON.stringify(message) + "\n",
    error => error ? reject(error) : resolve()));
}

// Also embedded in the page so WebDriver never silently converts a DOM node
// into a remote element reference or drops an unserializable object property.
function encodeResult(value) {
  return JSON.stringify(value === undefined ? null : value, function (key, item) {
    const original = this[key];
    if (original !== null && typeof original === "object") {
      const proto = Object.getPrototypeOf(original);
      if (!Array.isArray(original) && proto !== null && proto !== Object.prototype)
        throw new TypeError("Expected a plain JSON value, got " + Object.prototype.toString.call(original));
    } else if (["undefined", "symbol", "bigint", "function"].includes(typeof original)
        || (typeof original === "number" && !Number.isFinite(original))) {
      throw new TypeError("Value cannot be represented as JSON: " + String(original));
    }
    return item;
  });
}

function pageCode(body) {
  return `
const done = arguments[arguments.length - 1];
const encode = ${encodeResult.toString()};
(async (params) => {
${body}
})(arguments[0]).then(value => done({json: encode(value)}))
  .catch(error => done({error: String(error?.stack || error)}));
`;
}

async function run() {
  const { script, params } = await receive();
  const dir = dirname(script);
  let tail = Promise.resolve();
  function rpc(method, args) {
    // One WebDriver call at a time, including when a control script uses Promise.all.
    const next = tail.then(async () => {
      await send({ method, args });
      const reply = await receive();
      if (reply.error !== undefined) throw new Error(reply.error);
      return reply.result;
    });
    tail = next.catch(() => {});
    return next;
  }
  const evaluateBody = (body, args) => rpc("evaluate", { source: pageCode(body), params: args });
  const methods = {
    navigate: url => rpc("navigate", { url }),
    screenshot: () => rpc("screenshot", {}),
    evaluate: (fn, args = {}) => evaluateBody("return (" + fn.toString() + ")(params);", args),
    async runScriptFile(path, args = {}) {
      return evaluateBody(await readFile(resolve(dir, path), "utf8"), args);
    },
    uploadFile: (selector, path) => rpc("upload", { selector, path: resolve(dir, path) }),
    async download(trigger) {
      await rpc("beginDownload", {});
      try {
        await trigger();
        return await rpc("finishDownload", {});
      } finally {
        await rpc("endDownload", {});
      }
    },
  };
  let outstanding = 0;
  const browser = {};
  for (const [name, method] of Object.entries(methods)) {
    browser[name] = async (...args) => {
      outstanding++;
      try {
        return await method(...args);
      } finally {
        outstanding--;
      }
    };
  }
  const source = await readFile(script, "utf8");
  const AsyncFunction = (async function () {}).constructor;
  const control = new AsyncFunction("browser", "params", source + "\n//# sourceURL=" + pathToFileURL(script).href);
  const value = await control(browser, params);
  if (outstanding) throw new Error("Control script returned with browser operations still pending; await each operation");
  return JSON.parse(encodeResult(value));
}

try {
  await send({ done: true, result: await run() });
  process.exit(0);
} catch (error) {
  await send({ done: true, error: String(error?.stack || error) });
  process.exit(1);
}
