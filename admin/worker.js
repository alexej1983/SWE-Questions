// Cloudflare Worker: CORS proxy for GitHub OAuth device flow.
//
// Deploys to e.g. https://swe-questions-oauth.<your-subdomain>.workers.dev
//
// Endpoints:
//   POST /login/device/code           -> forwards to https://github.com/login/device/code
//   POST /login/oauth/access_token    -> forwards to https://github.com/login/oauth/access_token
//
// All requests must originate from ALLOWED_ORIGIN (set as a worker env var).
// No secrets are stored here — device flow uses only the OAuth App's public client_id.

const ALLOWED_PATHS = new Set([
  "/login/device/code",
  "/login/oauth/access_token",
]);

export default {
  async fetch(request, env) {
    const allowedOrigin = env.ALLOWED_ORIGIN || "*";
    const corsHeaders = {
      "Access-Control-Allow-Origin": allowedOrigin,
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Accept",
      "Access-Control-Max-Age": "86400",
      Vary: "Origin",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    const url = new URL(request.url);
    if (!ALLOWED_PATHS.has(url.pathname) || request.method !== "POST") {
      return new Response("Not found", { status: 404, headers: corsHeaders });
    }

    const upstream = await fetch(`https://github.com${url.pathname}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": "swe-questions-admin-oauth-proxy",
      },
      body: await request.text(),
    });

    const body = await upstream.text();
    return new Response(body, {
      status: upstream.status,
      headers: {
        ...corsHeaders,
        "Content-Type": upstream.headers.get("Content-Type") || "application/json",
      },
    });
  },
};
