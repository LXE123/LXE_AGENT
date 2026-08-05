import { describe, expect, test } from "bun:test";
import { resolveCloudDestinationUrl } from "../src/main/cloud-destinations";

const connectedInput = {
  configured: true,
  connection: "connected" as const,
  dataServerUrl: "http://10.88.0.1:8000",
  permissionProfile: "fba" as const,
};

describe("cloud destination URLs", () => {
  test("maps every destination onto the configured server origin", () => {
    expect(resolveCloudDestinationUrl({
      ...connectedInput,
      destination: "agent_dashboard",
    })).toBe("http://10.88.0.1:8000/dashboard");
    expect(resolveCloudDestinationUrl({
      ...connectedInput,
      dataServerUrl: "https://cloud.example/old/path/?source=settings#section",
      destination: "erp_dashboard",
    })).toBe("https://cloud.example/erp");
    expect(resolveCloudDestinationUrl({
      ...connectedInput,
      dataServerUrl: "https://admin:secret@cloud.example:9443/base",
      destination: "admin_dashboard",
    })).toBe("https://cloud.example:9443/admin");
  });

  test("requires a configured and connected cloud", () => {
    expect(() => resolveCloudDestinationUrl({
      ...connectedInput,
      configured: false,
      destination: "agent_dashboard",
    })).toThrow("尚未配置");
    expect(() => resolveCloudDestinationUrl({
      ...connectedInput,
      connection: "offline",
      destination: "erp_dashboard",
    })).toThrow("当前未连接");
  });

  test("allows FBA-capable profiles to open ERP and rejects all other profiles", () => {
    expect(resolveCloudDestinationUrl({
      ...connectedInput,
      permissionProfile: "full_access",
      destination: "erp_dashboard",
    })).toBe("http://10.88.0.1:8000/erp");
    for (const permissionProfile of ["replenishment", null] as const) {
      expect(() => resolveCloudDestinationUrl({
        ...connectedInput,
        permissionProfile,
        destination: "erp_dashboard",
      })).toThrow("没有 FBA ERP 访问权限");
    }
  });

  test("does not apply the ERP permission profile to other cloud destinations", () => {
    expect(resolveCloudDestinationUrl({
      ...connectedInput,
      permissionProfile: null,
      destination: "agent_dashboard",
    })).toBe("http://10.88.0.1:8000/dashboard");
    expect(resolveCloudDestinationUrl({
      ...connectedInput,
      permissionProfile: "replenishment",
      destination: "admin_dashboard",
    })).toBe("http://10.88.0.1:8000/admin");
  });

  test("rejects malformed and non-web server addresses", () => {
    expect(() => resolveCloudDestinationUrl({
      ...connectedInput,
      dataServerUrl: "not a url",
      destination: "agent_dashboard",
    })).toThrow("地址无效");
    expect(() => resolveCloudDestinationUrl({
      ...connectedInput,
      dataServerUrl: "file:///etc/passwd",
      destination: "admin_dashboard",
    })).toThrow("协议不受支持");
  });
});
