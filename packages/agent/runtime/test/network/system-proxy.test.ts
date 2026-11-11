import { describe, expect, test } from "bun:test";
import { cachedSystemProxy, parseMacSystemProxy, parseWindowsSystemProxy } from "../../src/network/system-proxy";
import { bypassesProxy, environmentRoute, systemRoute } from "../../src/network/proxy-route";

// scutil --proxy captured on macOS with Clash's manual HTTP/HTTPS proxy enabled.
const macSettings = `<dictionary> {
  ExceptionsList : <array> {
    0 : 127.0.0.1
    1 : 192.168.0.0/16
    2 : 10.0.0.0/8
    3 : 172.16.0.0/12
    4 : localhost
    5 : *.local
    6 : *.crashlytics.com
    7 : <local>
  }
  FTPPassive : 1
  HTTPEnable : 1
  HTTPPort : 7897
  HTTPProxy : 127.0.0.1
  HTTPSEnable : 1
  HTTPSPort : 7897
  HTTPSProxy : 127.0.0.1
  ProxyAutoConfigEnable : 0
  SOCKSEnable : 1
  SOCKSPort : 7897
  SOCKSProxy : 127.0.0.1
}`;

describe("manual system proxy settings", () => {
  test("parses actual macOS settings and ignores nested interface dictionaries", () => {
    const settings = parseMacSystemProxy(macSettings);
    expect(settings.http).toBe("http://127.0.0.1:7897/");
    expect(settings.https).toBe(settings.http);
    expect(settings.bypass).toHaveLength(8);
    const nested = macSettings.replace(/\}$/u, `  __SCOPED__ : <dictionary> {
      en1 : <dictionary> {
        HTTPProxy : another-proxy
        HTTPPort : 9999
      }
    }
  }`);
    expect(parseMacSystemProxy(nested)).toEqual(settings);
  });

  test("disabled and PAC-only settings do not become manual proxies", () => {
    expect(parseMacSystemProxy(macSettings.replace("HTTPEnable : 1", "HTTPEnable : 0")).http).toBeUndefined();
    expect(parseMacSystemProxy("<dictionary> {\n ProxyAutoConfigEnable : 1\n ProxyAutoConfigURLString : https://proxy.example/pac\n}")).toEqual({ bypass: [] });
    expect(parseMacSystemProxy("<dictionary> {\n}")).toEqual({ bypass: [] });
    expect(() => parseMacSystemProxy("permission denied")).toThrow("Invalid scutil");
    expect(() => parseMacSystemProxy(macSettings.replace("HTTPPort : 7897", "HTTPPort : 0"))).toThrow("Invalid system HTTP proxy");
  });

  test("Windows supports one manual proxy or separate protocol mappings", () => {
    expect(parseWindowsSystemProxy(JSON.stringify({ ProxyEnable: 1, ProxyServer: "127.0.0.1:7897", ProxyOverride: "*.local;<local>;10.0.0.1" })))
      .toEqual({ http: "http://127.0.0.1:7897/", https: "http://127.0.0.1:7897/", bypass: ["*.local", "<local>", "10.0.0.1"] });
    expect(parseWindowsSystemProxy(JSON.stringify({ ProxyEnable: 1, ProxyServer: "http=one:8080;https=two:8443;socks=three:1080" })))
      .toEqual({ http: "http://one:8080/", https: "http://two:8443/", bypass: [] });
    expect(parseWindowsSystemProxy('{"ProxyEnable":0,"ProxyServer":"old:1234"}')).toEqual({ bypass: [] });
    expect(parseWindowsSystemProxy("{}")).toEqual({ bypass: [] });
    expect(() => parseWindowsSystemProxy('{"ProxyEnable":1}')).toThrow("missing ProxyServer");
  });

  test("concurrent requests share a read, and settings refresh after five seconds", async () => {
    let calls = 0, time = 0;
    const read = cachedSystemProxy(async () => { calls++; return { bypass: [], http: `http://proxy:${calls}` }; }, () => time);
    const [one, two] = await Promise.all([read(), read()]);
    expect(one).toEqual(two); expect(calls).toBe(1);
    time = 4999; await read(); expect(calls).toBe(1);
    time = 5000; expect((await read()).http).toBe("http://proxy:2");
    const failure = new Error("scutil command failed");
    let attempts = 0;
    const broken = cachedSystemProxy(async () => { attempts++; throw failure; }, () => time);
    await expect(broken()).rejects.toBe(failure);
    await expect(broken()).rejects.toBe(failure);
    expect(attempts).toBe(1);
  });
});

describe("proxy route selection", () => {
  test("explicit environment wins; HTTP and HTTPS settings are independent", () => {
    const url = new URL("https://api.example.com");
    expect(environmentRoute(url, { HTTPS_PROXY: "http://explicit:8080", ALL_PROXY: "http://fallback:8081" }))
      .toEqual({ proxy: "http://explicit:8080/", source: "environment" });
    expect(environmentRoute(url, { HTTP_PROXY: "http://only-http:8080" })).toBeUndefined();
    expect(environmentRoute(url, { ALL_PROXY: "socks5h://127.0.0.1:7897" })).toBeUndefined();
    expect(environmentRoute(url, { all_proxy: "http://fallback:8081" })?.source).toBe("environment");
    const settings = { http: "http://one:80", https: "http://two:80", bypass: [] };
    expect(systemRoute(url, settings).proxy).toBe("http://two:80");
    expect(systemRoute(new URL("http://api.example.com"), settings).proxy).toBe("http://one:80");
    expect(systemRoute(url, { bypass: [] })).toEqual({ proxy: false, source: "direct" });
  });

  test("NO_PROXY and loopback bypass even an explicit proxy", () => {
    const env = { HTTPS_PROXY: "http://explicit:80", NO_PROXY: ".example.com:443,10.0.0.0/8" };
    expect(environmentRoute(new URL("https://api.example.com"), env)?.proxy).toBe(false);
    expect(environmentRoute(new URL("https://api.example.com:8443"), env)?.source).toBe("environment");
    for (const host of ["127.0.0.1", "127.0.0.2", "localhost", "localhost.", "[::1]"]) {
      expect(environmentRoute(new URL(`https://${host}:1234`), env)?.proxy).toBe(false);
    }
    expect(environmentRoute(new URL("https://api.example.com"), { ...env, no_proxy: "other.example" })?.source).toBe("environment");
  });

  test("system bypass lists support wildcards, IP subnets, IPv6 and simple hosts", () => {
    const settings = parseMacSystemProxy(macSettings);
    for (const host of ["192.168.3.42", "10.9.8.7", "printer", "printer.local", "a.crashlytics.com"]) {
      expect(systemRoute(new URL(`https://${host}`), settings).source).toBe("bypass");
    }
    expect(systemRoute(new URL("https://notcrashlytics.com"), settings).source).toBe("system");
    expect(bypassesProxy(new URL("https://[fd00::1]"), ["fd00::/8"])).toBe(true);
    expect(bypassesProxy(new URL("https://[2001:db8::1]:8443"), ["[2001:db8::1]:8443"])).toBe(true);
    expect(bypassesProxy(new URL("https://10.0.0.1"), ["10.0.0.0/999"])).toBe(false);
  });
});
