import type { CloudEnrollmentPayload } from "./cloud-enrollment";

export interface WireGuardTunnelConfiguration {
  tunnel_name: string;
  private_key: string;
  address: string;
  server_public_key: string;
  endpoint: string;
  allowed_ips: [string];
  persistent_keepalive: 25;
}

const text = (value: unknown): string => String(value ?? "").trim();

const wireGuardKey = (value: unknown): string => {
  const encoded = text(value);
  if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(encoded)) return "";
  const decoded = Buffer.from(encoded, "base64");
  return decoded.length === 32 && decoded.toString("base64") === encoded ? encoded : "";
};

export const parseWireGuardTunnelConfiguration = (
  value: unknown,
): WireGuardTunnelConfiguration | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  const tunnelName = text(candidate.tunnel_name);
  const privateKey = wireGuardKey(candidate.private_key);
  const address = text(candidate.address);
  const serverPublicKey = wireGuardKey(candidate.server_public_key);
  const endpoint = text(candidate.endpoint);
  const allowedIps = candidate.allowed_ips;
  if (!/^[A-Za-z0-9_-]{1,32}$/u.test(tunnelName)
    || !privateKey
    || !/^10\.88\.0\.(?:[2-9]|[1-9][0-9]|1[0-9]{2}|2[0-4][0-9]|25[0-4])\/32$/u.test(address)
    || !serverPublicKey
    || !/^[A-Za-z0-9.-]+:51820$/u.test(endpoint)
    || !Array.isArray(allowedIps)
    || allowedIps.length !== 1
    || allowedIps[0] !== "10.88.0.1/32"
    || candidate.persistent_keepalive !== 25) {
    return null;
  }
  return {
    tunnel_name: tunnelName,
    private_key: privateKey,
    address,
    server_public_key: serverPublicKey,
    endpoint,
    allowed_ips: ["10.88.0.1/32"],
    persistent_keepalive: 25,
  };
};

export const wireGuardTunnelFromEnrollment = (
  payload: CloudEnrollmentPayload,
  tunnelName = "lxe-agent",
): WireGuardTunnelConfiguration => ({
  tunnel_name: tunnelName,
  private_key: payload.wireguard.private_key,
  address: payload.wireguard.address,
  server_public_key: payload.wireguard.server_public_key,
  endpoint: payload.wireguard.endpoint,
  allowed_ips: [...payload.wireguard.allowed_ips],
  persistent_keepalive: payload.wireguard.persistent_keepalive,
});

export const wireGuardConfiguration = (configuration: WireGuardTunnelConfiguration): string => [
  "[Interface]",
  `PrivateKey = ${configuration.private_key}`,
  `Address = ${configuration.address}`,
  "",
  "[Peer]",
  `PublicKey = ${configuration.server_public_key}`,
  `AllowedIPs = ${configuration.allowed_ips.join(", ")}`,
  `Endpoint = ${configuration.endpoint}`,
  `PersistentKeepalive = ${configuration.persistent_keepalive}`,
  "",
].join("\r\n");
