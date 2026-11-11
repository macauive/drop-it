import { CaptureError, jsonRequest } from "./capture.js";

function randomSecret() {
  return base64url(crypto.getRandomValues(new Uint8Array(32)));
}
function base64url(bytes) {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}
export function readTokens(data, clientId) {
  if (
    !data ||
    typeof data.access_token !== "string" ||
    typeof data.refresh_token !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(data.access_token) ||
    !/^[A-Za-z0-9_-]{43}$/.test(data.refresh_token) ||
    typeof data.token_type !== "string" ||
    data.token_type.toLowerCase() !== "bearer" ||
    !Number.isInteger(data.expires_in) ||
    data.expires_in < 1 ||
    data.expires_in > 86400 ||
    typeof data.scope !== "string" ||
    !data.scope.split(" ").includes("capture:write")
  )
    throw new CaptureError(
      "Drop It returned an invalid connection. Connect again.",
    );
  return {
    access: data.access_token,
    refresh: data.refresh_token,
    expiresAt: Date.now() + data.expires_in * 1000,
    clientId,
  };
}

export function createOAuth(api, origin, transport = fetch) {
  const request = (path, init) => jsonRequest(origin, path, init, transport);
  const form = (body) => ({
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
  });
  let refreshing;
  let connecting;
  const token = (body) =>
    request("/token", form({ ...body, resource: `${origin}/mcp` }));
  return {
    connect() {
      if (connecting) return connecting;
      connecting = (async () => {
        const redirect = api.identity.getRedirectURL("drop-it");
        const client = await request("/register", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            client_name: "Drop It for Chrome",
            redirect_uris: [redirect],
            token_endpoint_auth_method: "none",
            grant_types: ["authorization_code", "refresh_token"],
            response_types: ["code"],
            scope: "capture:write",
          }),
        });
        if (
          typeof client?.client_id !== "string" ||
          !/^[a-f0-9-]{36}$/.test(client.client_id)
        )
          throw new CaptureError("Drop It returned an invalid connection.");
        const verifier = randomSecret(),
          state = randomSecret();
        const challenge = base64url(
          new Uint8Array(
            await crypto.subtle.digest(
              "SHA-256",
              new TextEncoder().encode(verifier),
            ),
          ),
        );
        const authorize = new URL(`${origin}/authorize`);
        authorize.search = new URLSearchParams({
          client_id: client.client_id,
          redirect_uri: redirect,
          response_type: "code",
          scope: "capture:write",
          resource: `${origin}/mcp`,
          code_challenge: challenge,
          code_challenge_method: "S256",
          state,
        }).toString();
        let returned;
        try {
          returned = await api.identity.launchWebAuthFlow({
            url: authorize.href,
            interactive: true,
          });
        } catch {
          throw new CaptureError(
            "Connection canceled. Open Drop It and connect again when ready.",
          );
        }
        let callback;
        try {
          callback = new URL(returned);
        } catch {
          throw new CaptureError(
            "Connection did not finish. Please reconnect.",
          );
        }
        if (
          `${callback.origin}${callback.pathname}` !== redirect ||
          callback.searchParams.get("state") !== state ||
          callback.hash ||
          callback.searchParams.getAll("state").length !== 1 ||
          callback.searchParams.getAll("code").length !== 1 ||
          callback.searchParams.has("error")
        )
          throw new CaptureError(
            "Connection was not approved. Please reconnect.",
          );
        const code = callback.searchParams.get("code");
        if (!/^[A-Za-z0-9_-]{43}$/.test(code))
          throw new CaptureError(
            "Connection did not finish. Please reconnect.",
          );
        const tokens = readTokens(
          await token({
            client_id: client.client_id,
            code,
            code_verifier: verifier,
            redirect_uri: redirect,
            grant_type: "authorization_code",
          }),
          client.client_id,
        );
        await api.storage.session.set({ connection: tokens });
      })().finally(() => {
        connecting = undefined;
      });
      return connecting;
    },
    async access() {
      const { connection } = await api.storage.session.get("connection");
      if (!connection)
        throw new CaptureError("Connect your Drop It account.", 401);
      if (connection.expiresAt > Date.now() + 60000) return connection.access;
      if (!refreshing)
        refreshing = (async () => {
          // Never retry a rotating refresh token after an uncertain network result.
          // A fresh sign-in is safer than replaying a token and revoking its family.
          try {
            const next = readTokens(
              await token({
                client_id: connection.clientId,
                refresh_token: connection.refresh,
                grant_type: "refresh_token",
              }),
              connection.clientId,
            );
            await api.storage.session.set({ connection: next });
            return next.access;
          } catch {
            await api.storage.session.remove("connection");
            throw new CaptureError(
              "Your connection expired. Reconnect your Drop It account.",
              401,
            );
          }
        })().finally(() => {
          refreshing = undefined;
        });
      return refreshing;
    },
    async disconnect() {
      const { connection } = await api.storage.session.get("connection");
      try {
        if (connection)
          await request(
            "/revoke",
            form({
              client_id: connection.clientId,
              token: connection.refresh,
              token_type_hint: "refresh_token",
            }),
          );
      } finally {
        await api.storage.session.remove("connection");
      }
    },
  };
}
