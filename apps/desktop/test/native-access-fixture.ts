/** Adapt legacy identity response fixtures to the new wire contracts.
 * The dedicated native-cloud tests exercise real transport and credential-free access.
 */
import { DesktopCloudService } from "../src/main/cloud/desktop-cloud";
import { CloudContextError } from "../src/main/cloud/cloud-context";
import { CloudHttpError, parseCloudError } from "../src/main/cloud/cloud-errors";
export function identityFixtureCloud(options: ConstructorParameters<typeof DesktopCloudService>[0]) {
  const fetcher = options.fetch;
  let response: Promise<Response> | undefined;
  let context: any;
  const readIdentity = async () => {
    if (!response) return {};
    const r = await response;
    if (!r.ok) throw new CloudContextError(await r.clone().text(), "context_http_error", r.status);
    return r.clone().json() as any;
  };
  const fetch: typeof globalThis.fetch = (input, init) => {
    const r = Promise.resolve(fetcher!(input, init));
    if (/\/identity(?:\/activate)?$/u.test(String(input))) {
      response = r.then(value => value.clone()); void response.catch(() => undefined);
    }
    return r;
  };
  const query = async (server: string, signal: AbortSignal) => {
    if (options.contextClient) context = await options.contextClient.query(server, signal);
    else {
      const body = await readIdentity();
      const p = body.permission_v2;
      context = { response_schema: "lxe.device-context.v1",
        device: { kind: body.principal_kind, id: body.device_id, display_name: body.display_name, wireguard_ip: body.wireguard_ip },
        permission: p ? { ...p, grants: { server_capabilities: [], erp_actions: [], ...p.grants } } : null };
    }
    return context;
  };
  return new DesktopCloudService({ ...options, ...(fetcher ? { fetch } : {}), contextClient: { query },
    accessClient: options.accessClient ?? { request: async (server, path, signal, body) => {
      const identity = await readIdentity();
      const device = context?.device;
      if (path === "/api/v1/device-access") {
        const m = identity.managed_llm;
        const target = m?.available ? { provider: m.provider, model: m.model } : null;
        const manifest = identity.managed_llm_v3 ?? identity.managed_llm_v2 ?? {
          revision: 1, default_target: target, models: target ? [{ ...target, available: true, credential_revision: m.credential_revision }] : [] };
        return { response_schema: "lxe.device-access.v1", device, management_role: identity.management_role ?? "member",
          management_version: identity.management_version ?? 1, managed_llm_v3: manifest };
      }
      const handoff = path.endsWith("/browser-handoff");
      if (handoff && !response) return { device, code: ((body as any)?.target === "erp" ? "lxe_erp_handoff_" : "lxe_handoff_") + "x".repeat(43), expires_at: 4_000_000_000 };
      const suffix = handoff ? "admin-handoff" : "llm-credential";
      const query = !handoff && (identity.managed_llm_v2 || identity.managed_llm_v3) ? path.slice(path.indexOf("?")) : "";
      const r = await fetcher!(server + "/api/v1/agent-data/identity/" + suffix + query,
        { method: handoff ? "POST" : "GET", headers: { authorization: "Bearer " + options.config.cloudIdentityCredential() },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      if (!r.ok) throw new CloudHttpError(parseCloudError(await r.text()), r.status, "Cloud request failed (HTTP " + r.status + ")");
      const result = await r.json();
      return handoff ? { device, ...result as object } : { device, credential: result };
    } },
  });
}
