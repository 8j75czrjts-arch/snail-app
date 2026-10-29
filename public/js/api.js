// Thin client for the Vercel API (api/index.py). Everything goes through /api?r=<route>.
const TOKEN_KEY = "sn.token";

export const getToken = () => { try { return localStorage.getItem(TOKEN_KEY); } catch { return null; } };
export const setToken = t => { try { t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY); } catch { /* private mode */ } };

export class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export async function api(method, route, body, params) {
  const headers = { "Content-Type": "application/json" };
  const token = getToken();
  if (token) headers["X-Token"] = token;
  const qs = new URLSearchParams({ r: route, ...(params || {}) });
  let res;
  try {
    res = await fetch(`/api?${qs}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw new ApiError(0, "No connection");
  }
  let data = null;
  try { data = await res.json(); } catch { /* empty body */ }
  if (!res.ok) throw new ApiError(res.status, (data && data.error) || "Something went wrong");
  return data;
}
