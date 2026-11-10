import { originForHost } from "./keepalive.js";

/** Must be started in the same turn as a click/submit (not from the service worker). */
export function requestHostPermissions(hosts) {
  const origins = (hosts || []).map(originForHost).filter(Boolean);
  if (!origins.length) return Promise.resolve(true);
  return chrome.permissions.request({ origins });
}

/** Broad HTTPS access (optional). Prefer requestHostPermissions for a specific tab. */
export function requestAllHttpsPermission() {
  return chrome.permissions.request({ origins: ["https://*/*"] });
}
