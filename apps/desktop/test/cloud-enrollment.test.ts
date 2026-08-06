import { afterEach, describe, expect, test } from "bun:test";
import { createCipheriv, randomBytes, scryptSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decryptCloudEnrollment,
  DesktopCloudEnrollmentManager,
  type CloudEnrollmentPayload,
} from "../src/main/cloud-enrollment";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const payload: CloudEnrollmentPayload & { format: string; version: number } = {
  enrollment_version: 1,
  format: "lxe-agent-enrollment-payload",
  version: 1,
  device: { id: "0123456789abcdef0123456789abcdef", name: "Finance-PC-01" },
  wireguard: {
    private_key: Buffer.alloc(32, 1).toString("base64"),
    address: "10.88.0.8/32",
    server_public_key: Buffer.alloc(32, 2).toString("base64"),
    endpoint: "43.139.140.124:51820",
    allowed_ips: ["10.88.0.1/32"],
    persistent_keepalive: 25,
  },
  data_server: {
    url: "http://10.88.0.1:8000",
    api_token: "lxe_dev_0123456789abcdef0123456789abcdef.ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef",
    sync_interval_seconds: 3_600,
  },
  erp: { api_token: "erp-dedicated-secret" },
};

const encrypt = (password: string, value: unknown = payload): Buffer => {
  const salt = randomBytes(16);
  const nonce = randomBytes(12);
  const normalized = Buffer.from(password.toUpperCase().replace(/[^A-Z0-9]/gu, ""), "ascii");
  const key = scryptSync(normalized, salt, 32, { N: 32_768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from("lxe-agent-enrollment:v1", "ascii"));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return Buffer.from(JSON.stringify({
    format: "lxe-agent-enrollment",
    version: 1,
    kdf: { name: "scrypt", salt: salt.toString("base64"), n: 32_768, r: 8, p: 1 },
    cipher: {
      name: "aes-256-gcm",
      nonce: nonce.toString("base64"),
      ciphertext: ciphertext.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
    },
  }));
};

describe("cloud enrollment", () => {
  test("decrypts and validates the versioned scrypt and AES-GCM bundle", () => {
    const result = decryptCloudEnrollment(encrypt("ABCD-EFGH-JKLM-NPQR-2345"), "abcd efgh jklm npqr 2345");
    expect(result).toEqual({
      enrollment_version: 1,
      device: payload.device,
      wireguard: payload.wireguard,
      data_server: payload.data_server,
      erp: payload.erp,
    });
  });

  test("keeps legacy enrollment payloads usable without ERP credentials", () => {
    const legacy = structuredClone(payload);
    delete legacy.erp;
    const result = decryptCloudEnrollment(
      encrypt("ABCD-EFGH-JKLM-NPQR-2345", legacy),
      "ABCD-EFGH-JKLM-NPQR-2345",
    );
    expect(result.erp).toBeUndefined();
    expect(result.data_server).toEqual(payload.data_server);
  });

  test("accepts enrollment v2 metadata without treating it as runtime authorization", () => {
    const versionTwo = structuredClone(payload);
    versionTwo.version = 2;
    versionTwo.enrollment_version = 2;
    versionTwo.device.permission_profile = "fba";
    versionTwo.device.permission_version = 1;

    const result = decryptCloudEnrollment(
      encrypt("ABCD-EFGH-JKLM-NPQR-2345", versionTwo),
      "ABCD-EFGH-JKLM-NPQR-2345",
    );

    expect(result).toMatchObject({
      enrollment_version: 2,
      device: { permission_profile: "fba", permission_version: 1 },
    });
  });

  test("accepts enrollment v3 compatibility metadata without embedded authorization", () => {
    const versionThree = structuredClone(payload);
    versionThree.version = 3;
    versionThree.enrollment_version = 3;
    versionThree.device.minimum_permission_contract_version = 2;

    const result = decryptCloudEnrollment(
      encrypt("ABCD-EFGH-JKLM-NPQR-2345", versionThree),
      "ABCD-EFGH-JKLM-NPQR-2345",
    );

    expect(result).toMatchObject({
      enrollment_version: 3,
      device: { minimum_permission_contract_version: 2 },
    });
    expect(result.device.permission_profile).toBeUndefined();
  });

  test("rejects a wrong password, tampering, and routes wider than the server address", () => {
    expect(() => decryptCloudEnrollment(encrypt("ABCD-EFGH-JKLM-NPQR-2345"), "WRONG-PASSWORD-234567"))
      .toThrow("设备文件或密码不正确");
    const unsafe = structuredClone(payload);
    unsafe.wireguard.allowed_ips = ["0.0.0.0/0"] as unknown as [string];
    expect(() => decryptCloudEnrollment(encrypt("ABCD-EFGH-JKLM-NPQR-2345", unsafe), "ABCD-EFGH-JKLM-NPQR-2345"))
      .toThrow("route is invalid");
  });

  test("keeps the selected path behind an opaque id", () => {
    const root = mkdtempSync(join(tmpdir(), "lxe-enrollment-"));
    roots.push(root);
    const path = join(root, "Finance-PC-01.lxe-enroll");
    writeFileSync(path, encrypt("ABCD-EFGH-JKLM-NPQR-2345"));
    const manager = new DesktopCloudEnrollmentManager();
    const selection = manager.select(path);
    expect(selection.file_name).toBe("Finance-PC-01.lxe-enroll");
    expect(JSON.stringify(selection)).not.toContain(root);
    expect(manager.decrypt(selection.enrollment_id, "ABCD-EFGH-JKLM-NPQR-2345").device.id)
      .toBe(payload.device.id);
    manager.complete(selection.enrollment_id);
    expect(() => manager.decrypt(selection.enrollment_id, "ABCD-EFGH-JKLM-NPQR-2345"))
      .toThrow("已过期");
  });
});
