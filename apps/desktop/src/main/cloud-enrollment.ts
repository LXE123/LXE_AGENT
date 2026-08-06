import { createDecipheriv, randomUUID, scryptSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import type { DesktopCloudEnrollmentSelection } from "@lxe/desktop-protocol";

const ENROLLMENT_AAD = Buffer.from("lxe-agent-enrollment:v1", "ascii");
const MAX_ENROLLMENT_BYTES = 128 * 1024;
const SELECTION_TTL_MS = 10 * 60_000;

export interface CloudEnrollmentPayload {
  enrollment_version: 1 | 2 | 3;
  device: {
    id: string;
    name: string;
    permission_profile?: "fba" | "replenishment" | "full_access";
    permission_version?: number;
    minimum_permission_contract_version?: 2;
  };
  wireguard: {
    private_key: string;
    address: string;
    server_public_key: string;
    endpoint: string;
    allowed_ips: [string];
    persistent_keepalive: 25;
  };
  data_server: {
    url: string;
    api_token: string;
    sync_interval_seconds: 3600;
  };
  erp?: { api_token: string };
}

interface PendingEnrollment {
  path: string;
  fileName: string;
  expiresAt: number;
}

const objectValue = (value: unknown, label: string): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
};

const exactText = (value: unknown, label: string, maximum = 2_048): string => {
  if (typeof value !== "string") throw new Error(`${label} must be text`);
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum) throw new Error(`${label} is invalid`);
  return normalized;
};

const decode = (value: unknown, label: string, size?: number): Buffer => {
  const encoded = exactText(value, label, MAX_ENROLLMENT_BYTES);
  if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(encoded)) throw new Error(`${label} is invalid`);
  const decoded = Buffer.from(encoded, "base64");
  if (decoded.toString("base64") !== encoded || (size !== undefined && decoded.length !== size)) {
    throw new Error(`${label} is invalid`);
  }
  return decoded;
};

const normalizedPassword = (password: string): Buffer => {
  const normalized = password.toUpperCase().replace(/[^A-Z0-9]/gu, "");
  if (normalized.length < 12 || normalized.length > 128) {
    throw new Error("设备密码无效");
  }
  return Buffer.from(normalized, "ascii");
};

const wireGuardKey = (value: unknown, label: string): string => {
  const encoded = exactText(value, label, 64);
  decode(encoded, label, 32);
  return encoded;
};

const validatePayload = (value: unknown): CloudEnrollmentPayload => {
  const payload = objectValue(value, "Enrollment payload");
  if (payload.format !== "lxe-agent-enrollment-payload"
    || (payload.version !== 1 && payload.version !== 2 && payload.version !== 3)) {
    throw new Error("不支持的设备文件版本");
  }
  const enrollmentVersion = payload.version;
  const device = objectValue(payload.device, "Device");
  const wireguard = objectValue(payload.wireguard, "WireGuard");
  const dataServer = objectValue(payload.data_server, "Data server");
  const erp = payload.erp === undefined ? undefined : objectValue(payload.erp, "ERP");
  const deviceId = exactText(device.id, "Device ID", 64);
  if (!/^[a-f0-9]{32}$/u.test(deviceId)) throw new Error("Device ID is invalid");
  const deviceName = exactText(device.name, "Device name", 128);
  let enrollmentPermission: {
    permission_profile?: "fba" | "replenishment" | "full_access";
    permission_version: number;
    minimum_permission_contract_version?: 2;
  } | undefined;
  if (enrollmentVersion === 2) {
    const permissionProfile = exactText(
      device.permission_profile,
      "Device permission profile",
      32,
    );
    if (permissionProfile !== "fba"
      && permissionProfile !== "replenishment"
      && permissionProfile !== "full_access") {
      throw new Error("Device permission profile is invalid");
    }
    if (typeof device.permission_version !== "number"
      || !Number.isSafeInteger(device.permission_version)
      || device.permission_version < 1) {
      throw new Error("Device permission version is invalid");
    }
    enrollmentPermission = {
      permission_profile: permissionProfile as "fba" | "replenishment" | "full_access",
      permission_version: device.permission_version,
    };
  } else if (enrollmentVersion === 3) {
    if (device.permission_profile !== undefined || device.permission_version !== undefined
      || device.minimum_permission_contract_version !== 2) {
      throw new Error("Device permission contract metadata is invalid");
    }
    enrollmentPermission = {
      permission_version: 0,
      minimum_permission_contract_version: 2,
    };
  }
  const address = exactText(wireguard.address, "WireGuard address", 32);
  if (!/^10\.88\.0\.(?:[2-9]|[1-9][0-9]|1[0-9]{2}|2[0-4][0-9]|25[0-4])\/32$/u.test(address)) {
    throw new Error("WireGuard address is invalid");
  }
  const endpoint = exactText(wireguard.endpoint, "WireGuard endpoint", 256);
  if (!/^[A-Za-z0-9.-]+:51820$/u.test(endpoint)) throw new Error("WireGuard endpoint is invalid");
  if (!Array.isArray(wireguard.allowed_ips)
    || wireguard.allowed_ips.length !== 1
    || wireguard.allowed_ips[0] !== "10.88.0.1/32") {
    throw new Error("WireGuard route is invalid");
  }
  if (wireguard.persistent_keepalive !== 25) throw new Error("WireGuard keepalive is invalid");
  const dataServerUrl = exactText(dataServer.url, "Data server URL", 256).replace(/\/+$/u, "");
  if (dataServerUrl !== "http://10.88.0.1:8000") throw new Error("Data server URL is invalid");
  const apiToken = exactText(dataServer.api_token, "Device upload token", 512);
  if (!/^lxe_dev_[a-f0-9]{32}\.[A-Za-z0-9_-]{32,}$/u.test(apiToken)) {
    throw new Error("Device upload token is invalid");
  }
  if (dataServer.sync_interval_seconds !== 3_600) throw new Error("Data sync interval is invalid");
  const erpApiToken = erp === undefined ? "" : exactText(erp.api_token, "ERP API token", 512);
  return {
    enrollment_version: enrollmentVersion,
    device: {
      id: deviceId,
      name: deviceName,
      ...(enrollmentVersion === 2 ? enrollmentPermission : {}),
      ...(enrollmentVersion === 3
        ? { minimum_permission_contract_version: 2 as const }
        : {}),
    },
    wireguard: {
      private_key: wireGuardKey(wireguard.private_key, "WireGuard private key"),
      address,
      server_public_key: wireGuardKey(wireguard.server_public_key, "WireGuard server public key"),
      endpoint,
      allowed_ips: ["10.88.0.1/32"],
      persistent_keepalive: 25,
    },
    data_server: {
      url: dataServerUrl,
      api_token: apiToken,
      sync_interval_seconds: 3_600,
    },
    ...(erpApiToken ? { erp: { api_token: erpApiToken } } : {}),
  };
};

export function decryptCloudEnrollment(content: Buffer, password: string): CloudEnrollmentPayload {
  if (content.length === 0 || content.length > MAX_ENROLLMENT_BYTES) {
    throw new Error("设备文件大小无效");
  }
  try {
    const document = objectValue(JSON.parse(content.toString("utf8")), "Enrollment file");
    if (document.format !== "lxe-agent-enrollment" || document.version !== 1) {
      throw new Error("不支持的设备文件版本");
    }
    const kdf = objectValue(document.kdf, "Enrollment KDF");
    const cipher = objectValue(document.cipher, "Enrollment cipher");
    if (kdf.name !== "scrypt" || kdf.n !== 32_768 || kdf.r !== 8 || kdf.p !== 1
      || cipher.name !== "aes-256-gcm") {
      throw new Error("不支持的设备文件加密方式");
    }
    const salt = decode(kdf.salt, "Enrollment salt", 16);
    const nonce = decode(cipher.nonce, "Enrollment nonce", 12);
    const ciphertext = decode(cipher.ciphertext, "Enrollment ciphertext");
    const tag = decode(cipher.tag, "Enrollment tag", 16);
    const key = scryptSync(normalizedPassword(password), salt, 32, {
      N: 32_768,
      r: 8,
      p: 1,
      maxmem: 64 * 1024 * 1024,
    });
    const decipher = createDecipheriv("aes-256-gcm", key, nonce);
    decipher.setAAD(ENROLLMENT_AAD);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return validatePayload(JSON.parse(plaintext.toString("utf8")));
  } catch (error) {
    if (error instanceof Error && (
      error.message.startsWith("不支持")
      || error.message.endsWith("is invalid")
      || error.message.endsWith("must be an object")
      || error.message.endsWith("must be text")
    )) throw error;
    throw new Error("设备文件或密码不正确");
  }
}

export class DesktopCloudEnrollmentManager {
  private readonly pending = new Map<string, PendingEnrollment>();

  select(path: string): DesktopCloudEnrollmentSelection {
    const fileName = basename(path);
    if (!fileName.toLowerCase().endsWith(".lxe-enroll")) {
      throw new Error("请选择 .lxe-enroll 设备文件");
    }
    const enrollmentId = randomUUID();
    const expiresAt = Date.now() + SELECTION_TTL_MS;
    this.pending.set(enrollmentId, { path, fileName, expiresAt });
    return { enrollment_id: enrollmentId, file_name: fileName, expires_at: expiresAt };
  }

  decrypt(enrollmentId: string, password: string): CloudEnrollmentPayload {
    this.prune();
    const pending = this.pending.get(enrollmentId);
    if (!pending) throw new Error("设备文件选择已过期，请重新选择");
    return decryptCloudEnrollment(readFileSync(pending.path), password);
  }

  complete(enrollmentId: string): void {
    this.pending.delete(enrollmentId);
  }

  private prune(): void {
    const now = Date.now();
    for (const [id, pending] of this.pending) {
      if (pending.expiresAt <= now) this.pending.delete(id);
    }
  }
}
