export const EXTERNAL_MCP_HTTP_BEARER_ENV = "NETCATTY_MCP_BEARER_TOKEN";
export const DEFAULT_EXTERNAL_MCP_HTTP_PORT = 47391;
export const DEFAULT_EXTERNAL_MCP_HTTP_HOST = "127.0.0.1";
export const EXTERNAL_MCP_HTTP_PATH = "/mcp";

function formatHostForUrl(host: string): string {
  if (host.includes(":") && !host.startsWith("[")) return `[${host}]`;
  return host;
}

function isWildcardBind(address: string): boolean {
  return address === "0.0.0.0" || address === "::";
}

export function buildExternalMcpHttpUrl(listenAddress: string, port: number, clientHost = ""): string {
  const host = isWildcardBind(listenAddress) ? clientHost.trim() : listenAddress;
  if (!host || isWildcardBind(host)) return "";
  return `http://${formatHostForUrl(host)}:${port}${EXTERNAL_MCP_HTTP_PATH}`;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function buildCodexHttpToml(url: string): string {
  return [
    "[mcp_servers.netcatty-http]",
    `url = ${JSON.stringify(url)}`,
    `bearer_token_env_var = ${JSON.stringify(EXTERNAL_MCP_HTTP_BEARER_ENV)}`,
  ].join("\n");
}

export function buildCodexHttpEnvLine(token: string): string {
  return `export ${EXTERNAL_MCP_HTTP_BEARER_ENV}=${shellQuote(token)}`;
}

export function buildClaudeHttpAddCommand(url: string, token: string): string {
  return [
    "claude mcp add --transport http netcatty-http",
    shellQuote(url),
    "--header",
    shellQuote(`Authorization: Bearer ${token}`),
  ].join(" ");
}

export function buildGenericHttpMcpJson(url: string, token: string): string {
  return JSON.stringify({
    mcpServers: {
      "netcatty-http": {
        type: "http",
        url,
        headers: {
          Authorization: `Bearer ${token}`,
        },
      },
    },
  }, null, 2);
}
