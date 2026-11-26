/** Native business discovery does not require an enrollment or a credential. */
export function companyServerUrl(cloud: { managed: boolean; switch_in_progress: boolean; data_server_url: string }): string {
  if (cloud.switch_in_progress) return "";
  return cloud.managed ? cloud.data_server_url.replace(/\/+$/u, "") : "http://10.88.0.1:8000";
}
