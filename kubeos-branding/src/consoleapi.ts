/**
 * The one place that talks to `kubeos-console.service`, the node's own agent.
 *
 * WHY IT EXISTS: no dashboard button may create a Pod (user decision 2026-11-12), so every
 * host-side ability - the shell, restart, power off, and the NFS file browser - has to reach
 * the service that runs on the node. That service listens on its own TLS port with the
 * dashboard's certificate and requires a per-machine token, which it publishes as a Secret;
 * this module is how a page gets that token and builds a URL for it.
 *
 * WHY A SECRET AND NOT A CONSTANT: the token is per machine and must never ship in the ISO.
 * Anyone who can read that Secret can open a root shell - but the dashboard's own kubeconfig
 * is cluster-admin with no login, so that is the same set of people who can already do
 * anything on this node. The token stops a port scan and a stray web page, not the operator.
 */
import { ApiProxy } from "@kinvolk/headlamp-plugin/lib";

const NAMESPACE = "kubeos-system";
const CONSOLE_SECRET = "kubeos-console-token";
/** Default port of kubeos-console.service; the Secret may override it. */
const CONSOLE_PORT = 30444;

export type ConsoleConfig = { token: string; port: number };

/**
 * Read the token (and the port, if the installer wrote one) from the Secret.
 * Errors are phrased for the person looking at the page, not for a log.
 */
export async function consoleConfig(): Promise<ConsoleConfig> {
  let secret: any;
  try {
    const response: any = await ApiProxy.request(
      `/api/v1/namespaces/${NAMESPACE}/secrets/${CONSOLE_SECRET}`
    );
    secret = response?.json ?? response;
  } catch (reason: any) {
    throw new Error(
      `the host console is not installed on this node (Secret ${NAMESPACE}/${CONSOLE_SECRET} is missing): re-run install.sh. ${String(
        reason?.message ?? reason
      )}`
    );
  }
  const data = secret?.data ?? {};
  const decode = (value: any) => (value ? atob(String(value)) : "");
  const token = decode(data.token);
  if (!token) {
    throw new Error(
      `Secret ${NAMESPACE}/${CONSOLE_SECRET} has no token: re-run install.sh`
    );
  }
  return { token, port: Number(decode(data.port)) || CONSOLE_PORT };
}

/**
 * The URL of a console path on this node.
 *
 * `window.location.hostname` rather than a fixed name: the dashboard may be reached by IP or
 * by DNS, and the certificate carries whichever the installer put in it.
 */
export function consoleUrl(path: string, port: number): string {
  return `https://${window.location.hostname}:${port}${path}`;
}

/** The one-line explanation a browser needs when a console call fails on the certificate. */
export function certificateHint(port: number): string {
  return `If this browser has never opened https://${window.location.hostname}:${port}/ , do that once, accept the certificate warning, then try again.`;
}

/**
 * Fetch from the console with the token attached, and turn every failure into a sentence.
 * A network error and a refused token look the same to `fetch`, so they are separated here.
 */
export async function consoleFetch(
  config: ConsoleConfig,
  path: string,
  init: RequestInit = {}
): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(consoleUrl(path, config.port), {
      ...init,
      headers: { ...(init.headers ?? {}), Authorization: `Bearer ${config.token}` },
    });
  } catch (reason: any) {
    throw new Error(
      `could not reach the node console on port ${config.port}. ${certificateHint(
        config.port
      )} (${String(reason?.message ?? reason)})`
    );
  }
  return response;
}

/** Read a JSON answer, or throw the service's own `error` sentence. */
export async function consoleJson<T>(response: Response): Promise<T> {
  let body: any = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  if (!response.ok) {
    throw new Error(
      body?.error ?? `${response.status} ${response.statusText}`.trim()
    );
  }
  return body as T;
}
