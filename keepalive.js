/** Shared host parsing and login-page detection (no chrome APIs). */

export const ALARM_NAME = "panorama-keepalive";
export const ALARM_PREFIX = "pano-ka:";
export const INTERVAL_MINUTES = 10;
export const INTERVAL_OPTIONS = [5, 10, 15, 20, 30];
export const DEFAULT_INTERVAL_MINUTES = 10;
export const HOUR_OPTIONS = [1, 2, 4, 8, 12, 24];
export const DEFAULT_HOURS = 8;

/** Logged-in UI ServerToken (st0). Login pages often set st10 — that is not a session. */
const SERVER_TOKEN_RE = /window\.Pan\.st\.st\.st0\s=\s"([^"]+)"/;
/** Any Pan.st.st.stN assignment — identifies PAN-OS UI HTML, including the login page. */
const PAN_ST_ANY_RE = /window\.Pan\.st\.st\.st[0-9]+\s=\s"([^"]+)"/;
const LOGIN_BODY_RE = /name=["']passwd["']|name=["']user["'][\s\S]*Log In|php\/login\.php/i;

export const ALIAS_MAX_LENGTH = 48;

export function normalizeHost(input) {
  let text = String(input || "").trim();
  if (!text) return "";
  text = text.replace(/^https?:\/\//i, "");
  text = text.split("/")[0].split("?")[0].split("#")[0];
  text = text.replace(/:\d+$/, "");
  return text.toLowerCase();
}

export function sanitizeAlias(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, ALIAS_MAX_LENGTH);
}

export function looksLikeHostToken(token) {
  const host = normalizeHost(token);
  if (!host) return false;
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) return true;
  return host.includes(".");
}

export function parseHostLine(line) {
  let text = String(line || "").trim();
  if (!text || text.startsWith("#")) return { host: "", alias: "" };

  let aliasHint = "";
  const sep = text.match(/\s+[#|]\s+(.*)$/);
  if (sep) {
    aliasHint = sep[1].trim();
    text = text.slice(0, sep.index).trim();
  }

  const tokens = text.split(/\s+/).filter(Boolean);
  const hostIdx = tokens.findIndex(looksLikeHostToken);
  const hintHost = aliasHint.split(/\s+/).find(looksLikeHostToken) || "";
  if (hostIdx < 0 && hintHost) {
    return {
      host: normalizeHost(hintHost),
      alias: sanitizeAlias(tokens.join(" ")),
    };
  }

  const host = normalizeHost(tokens[hostIdx >= 0 ? hostIdx : 0] || "");
  if (!host) return { host: "", alias: "" };
  const otherTokens = tokens.filter((_, i) => i !== (hostIdx >= 0 ? hostIdx : 0));
  return { host, alias: sanitizeAlias(aliasHint || otherTokens.join(" ")) };
}

export function parseHostEntries(raw) {
  const seen = new Set();
  const entries = [];
  for (const line of String(raw || "").split(/\r?\n/)) {
    const entry = parseHostLine(line);
    if (!entry.host || seen.has(entry.host)) continue;
    seen.add(entry.host);
    entries.push(entry);
  }
  for (const preset of PRESET_ENTRIES) {
    const host = normalizeHost(preset.host);
    if (!host || seen.has(host)) continue;
    seen.add(host);
    entries.push({ host, alias: sanitizeAlias(preset.alias) });
  }
  return entries;
}

export function parseHostList(raw) {
  return parseHostEntries(raw).map((entry) => entry.host);
}

export function serializeHostEntries(entries) {
  return (entries || [])
    .map((entry) => {
      const host = normalizeHost(entry?.host);
      if (!host) return "";
      const alias = sanitizeAlias(entry?.alias);
      return alias ? `${host} ${alias}` : host;
    })
    .filter(Boolean)
    .join("\n");
}

export function hostLabel(host, alias) {
  return sanitizeAlias(alias) || normalizeHost(host);
}

export const SCM_HOST = "stratacloudmanager.paloaltonetworks.com";
export const PRESET_ENTRIES = [{ host: SCM_HOST, alias: "SCM" }];

export function isScmHost(host) {
  const key = normalizeHost(host);
  if (!key) return false;
  return key === SCM_HOST || key.endsWith(`.${SCM_HOST}`) || key.includes("stratacloudmanager");
}

export function hostKind(host, { ephemeral = false } = {}) {
  if (ephemeral) return "firewall";
  return isScmHost(host) ? "scm" : "panorama";
}

/** Exact PAN-OS management UI paths (query/hash ignored; trailing slash ok). */
export const PAN_OS_MGMT_PATHS = ["/php/login.php", "/php/logout.php"];

function pathnameFromUrl(url) {
  try {
    return new URL(String(url || "")).pathname.replace(/\/+$/, "") || "/";
  } catch {
    const text = String(url || "").toLowerCase().split(/[?#]/)[0].replace(/\/+$/, "");
    const idx = text.indexOf("/");
    return idx >= 0 ? text.slice(idx) || "/" : "/";
  }
}

/** True for /php/login.php or /php/logout.php only. */
export function isPanOsMgmtUrl(url) {
  return PAN_OS_MGMT_PATHS.includes(pathnameFromUrl(url));
}

/** @deprecated use isPanOsMgmtUrl */
export function isPanOsLoginUrl(url) {
  return pathnameFromUrl(url) === "/php/login.php";
}

/** Authenticated PAN-OS/Panorama UI: exact st0 ServerToken in page HTML (not login st10). */
export function hasPanOsServerToken(body) {
  return SERVER_TOKEN_RE.test(String(body || ""));
}

/** PAN-OS UI HTML (login or app), including non-st0 Pan.st tokens. */
export function looksLikePanOsHtml(body) {
  return PAN_ST_ANY_RE.test(String(body || "")) || hasPanOsServerToken(body);
}

/**
 * True only for hard PAN-OS identifiers:
 * - URL path exactly /php/login.php or /php/logout.php, or
 * - body contains any window.Pan.st.st.stN = "…"
 */
export function looksLikePanOsUi(url, body) {
  if (isPanOsMgmtUrl(url)) return true;
  return looksLikePanOsHtml(body);
}

export function looksLikeScmLoginUrl(url) {
  const text = String(url || "").toLowerCase();
  if (!text) return false;
  return /identity\.paloaltonetworks|login\.microsoftonline|auth\.apps\.paloaltonetworks|sso\.paloaltonetworks/.test(
    text,
  );
}

export function originForHost(host) {
  const key = normalizeHost(host);
  return key ? `https://${key}/*` : "";
}

export function looksLikeLoginUrl(url) {
  const text = String(url || "").toLowerCase();
  if (!text) return false;
  // PAN-OS mgmt login/logout, plus common path fragments
  if (text.includes("login.php") || text.includes("logout.php")) return true;
  try {
    if (isPanOsMgmtUrl(text)) return true;
  } catch {
    /* ignore */
  }
  return false;
}

/** SSO / PAN idle-timeout interstitial copy. */
export function looksLikeIdleLogoutPage(body) {
  return /logged out due to inactivity|you have been logged out/i.test(String(body || ""));
}

/** Hostname from a tab URL, or "" if not a usable https host. */
export function hostFromTabUrl(url) {
  const text = String(url || "").trim();
  if (!text || !/^https:/i.test(text)) return "";
  try {
    return normalizeHost(new URL(text).hostname);
  } catch {
    return normalizeHost(text);
  }
}

/**
 * If the tab URL belongs to a configured host and does not look like a login
 * page, return that configured host; otherwise "".
 */
export function matchConfiguredHostFromTab(url, configuredHosts) {
  const tabHost = hostFromTabUrl(url);
  if (!tabHost) return "";
  const allowed = new Set(
    (configuredHosts || []).map((host) => normalizeHost(host)).filter(Boolean),
  );
  if (!allowed.has(tabHost)) return "";
  if (looksLikeLoginUrl(url)) return "";
  if (isScmHost(tabHost) && looksLikeScmLoginUrl(url)) return "";
  return tabHost;
}

export function looksLikeLoginPage(url, body) {
  if (looksLikeLoginUrl(url) || isPanOsMgmtUrl(url)) return true;
  const text = String(body || "");
  if (looksLikeIdleLogoutPage(text)) return true;
  if (SERVER_TOKEN_RE.test(text)) return false;
  return LOGIN_BODY_RE.test(text);
}

export function isAuthenticatedPage(url, status, body) {
  if (status >= 400) return false;
  return !looksLikeLoginPage(url, body);
}

export function isLoginExpiredReason(reason) {
  const text = String(reason || "").toLowerCase();
  return text.includes("login expired") || text.includes("sign in again");
}

export function clampHours(hours) {
  const n = Number(hours);
  if (!Number.isFinite(n)) return DEFAULT_HOURS;
  if (HOUR_OPTIONS.includes(n)) return n;
  return Math.min(24, Math.max(1, Math.round(n)));
}

export function clampIntervalMinutes(minutes) {
  const n = Number(minutes);
  if (INTERVAL_OPTIONS.includes(n)) return n;
  if (!Number.isFinite(n)) return DEFAULT_INTERVAL_MINUTES;
  const nearest = INTERVAL_OPTIONS.reduce((best, option) =>
    Math.abs(option - n) < Math.abs(best - n) ? option : best,
  );
  return nearest;
}

export function alarmNameForHost(host) {
  const key = normalizeHost(host);
  return key ? `${ALARM_PREFIX}${key}` : "";
}

export function hostFromAlarmName(name) {
  const text = String(name || "");
  if (!text.startsWith(ALARM_PREFIX)) return "";
  return normalizeHost(text.slice(ALARM_PREFIX.length));
}

export function remainingMs(untilIso, now = Date.now()) {
  const until = Date.parse(String(untilIso || ""));
  if (!Number.isFinite(until)) return 0;
  return Math.max(0, until - now);
}

export function emptyHostState() {
  return {
    enabled: false,
    until: "",
    untilManual: false,
    ephemeral: false,
    lastOkAt: "",
    lastError: "",
    intervalMinutes: DEFAULT_INTERVAL_MINUTES,
    alias: "",
  };
}

export function emptyEphemeralHostState() {
  return {
    ...emptyHostState(),
    enabled: true,
    until: "",
    untilManual: true,
    ephemeral: true,
    alias: "This tab",
  };
}

/** Drop keep-alive enablement; keep aliases and intervals. Used after a browser restart. */
export function deactivateAllHosts(hosts) {
  const next = {};
  for (const [host, row] of Object.entries(hosts && typeof hosts === "object" ? hosts : {})) {
    const base = row && typeof row === "object" ? row : {};
    next[host] = {
      ...emptyHostState(),
      ...base,
      enabled: false,
      until: "",
      lastOkAt: "",
      lastError: "",
      intervalMinutes: clampIntervalMinutes(base.intervalMinutes),
      alias: sanitizeAlias(base.alias),
    };
  }
  return next;
}

export function mergeHostMap(hostsText, existing) {
  const prev = existing && typeof existing === "object" ? existing : {};
  const next = {};
  for (const entry of parseHostEntries(hostsText)) {
    const row = prev[entry.host];
    const merged = {
      ...emptyHostState(),
      ...(row && typeof row === "object" ? row : {}),
    };
    merged.intervalMinutes = clampIntervalMinutes(merged.intervalMinutes);
    const fromText = sanitizeAlias(entry.alias);
    merged.alias = fromText || sanitizeAlias(merged.alias);
    next[entry.host] = merged;
  }
  return next;
}

export function serializeHostsText(hostsText, hosts) {
  const map = mergeHostMap(hostsText, hosts);
  return serializeHostEntries(
    parseHostList(hostsText).map((host) => ({
      host,
      alias: map[host]?.alias || "",
    })),
  );
}

export const REASON_DURATION_ENDED = "Keep-alive duration ended";
export const REASON_TURNED_OFF = "Turned off";

export function isKeepAlivePingFailure(reason) {
  const text = String(reason || "");
  if (!text) return false;
  return text !== REASON_DURATION_ENDED && text !== REASON_TURNED_OFF;
}

export function hostStatusReason(row, now = Date.now()) {
  if (!row) return "";
  const pingFail = isKeepAlivePingFailure(row.lastError) ? row.lastError : "";
  if (isHostKeepAliveActive(row, now)) return pingFail;
  if (row.enabled && row.until && !row.untilManual && remainingMs(row.until, now) <= 0) {
    return pingFail || REASON_DURATION_ENDED;
  }
  return pingFail || row.lastError || "";
}

export function isHostKeepAliveActive(row, now = Date.now()) {
  if (!row || !row.enabled) return false;
  if (row.untilManual) return true;
  return remainingMs(row.until, now) > 0;
}

function rowFromState(host, row, { ephemeral = false, now = Date.now() } = {}) {
  const active = isHostKeepAliveActive(row, now);
  const alias = sanitizeAlias(row?.alias);
  const kind = hostKind(host, { ephemeral: ephemeral || Boolean(row?.ephemeral) });
  return {
    host,
    alias,
    label: hostLabel(host, alias),
    enabled: active,
    status: active ? "Active" : "Inactive",
    until: row?.untilManual ? "" : row?.until || "",
    untilManual: Boolean(row?.untilManual),
    ephemeral: Boolean(ephemeral || row?.ephemeral),
    lastOkAt: row?.lastOkAt || "",
    lastError: hostStatusReason(row, now),
    intervalMinutes: clampIntervalMinutes(row?.intervalMinutes),
    kind,
  };
}

export function buildHostRows({ hostsText, hosts, ephemeralHosts, now = Date.now() } = {}) {
  const map = mergeHostMap(hostsText, hosts);
  const rows = parseHostList(hostsText).map((host) => rowFromState(host, map[host], { now }));
  const seen = new Set(rows.map((row) => row.host));
  const ephemeral = ephemeralHosts && typeof ephemeralHosts === "object" ? ephemeralHosts : {};
  for (const [host, row] of Object.entries(ephemeral)) {
    const key = normalizeHost(host);
    if (!key || seen.has(key)) continue;
    rows.push(rowFromState(key, row, { ephemeral: true, now }));
  }
  return rows;
}

export function anyHostActive(hostsText, hosts, ephemeralHosts, now = Date.now()) {
  return buildHostRows({ hostsText, hosts, ephemeralHosts, now }).some((row) => row.enabled);
}

export function connectingNote(seconds, kind = "panorama") {
  const n = Math.max(0, Math.floor(Number(seconds) || 0));
  const who = kind === "scm" ? "SCM" : kind === "firewall" ? "firewall" : "Panorama";
  return n === 0 ? `Contacting ${who}…` : `Contacting ${who}… ${n}s`;
}
