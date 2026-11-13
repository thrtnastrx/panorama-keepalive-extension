import {
  ALARM_NAME,
  ALARM_PREFIX,
  DEFAULT_HOURS,
  alarmNameForHost,
  anyHostActive,
  buildHostRows,
  clampHours,
  clampIntervalMinutes,
  hostFromAlarmName,
  hostLabel,
  isAuthenticatedPage,
  isHostKeepAliveActive,
  isKeepAlivePingFailure,
  isLoginExpiredReason,
  emptyEphemeralHostState,
  hostFromTabUrl,
  isPanOsMgmtUrl,
  isScmHost,
  looksLikeScmLoginUrl,
  matchConfiguredHostFromTab,
  mergeHostMap,
  normalizeHost,
  originForHost,
  parseHostList,
  REASON_DURATION_ENDED,
  REASON_TURNED_OFF,
  deactivateAllHosts,
  sanitizeAlias,
  serializeHostsText,
} from "./keepalive.js";

const DEFAULTS = {
  hours: DEFAULT_HOURS,
  hostsText: "",
  hosts: {},
  autoEnableOnTab: false,
};

const SESSION_MARKER_KEY = "kaBrowserSession";
const SESSION_SKIP_KEY = "kaAutoEnableSkip";
const SESSION_EPHEMERAL_KEY = "kaEphemeralHosts";

async function resetKeepAliveForNewBrowserSession() {
  let alreadyMarked = false;
  try {
    const marker = await chrome.storage.session.get(SESSION_MARKER_KEY);
    alreadyMarked = Boolean(marker?.[SESSION_MARKER_KEY]);
  } catch {
    alreadyMarked = false;
  }
  if (alreadyMarked) return;

  const state = await storageGet();
  const hosts = deactivateAllHosts(state.hosts);
  await storageSet({ hosts });
  try {
    await chrome.alarms.clearAll();
  } catch {
    /* ignore */
  }
  await syncBadge({ ...state, hosts, ephemeralHosts: {} });
  try {
    await chrome.storage.session.set({
      [SESSION_MARKER_KEY]: true,
      [SESSION_SKIP_KEY]: {},
      [SESSION_EPHEMERAL_KEY]: {},
    });
  } catch {
    /* session storage unavailable — onStartup still clears once */
  }
}

const sessionReady = resetKeepAliveForNewBrowserSession();

function storageGet() {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get(DEFAULTS, (items) => {
      const err = chrome.runtime.lastError;
      if (err) {
        reject(new Error(err.message));
        return;
      }
      const raw = { ...DEFAULTS, ...items };
      raw.hours = clampHours(raw.hours);
      raw.hostsText = String(raw.hostsText || "");
      raw.hosts = mergeHostMap(raw.hostsText, raw.hosts);
      raw.autoEnableOnTab = Boolean(raw.autoEnableOnTab);
      resolve(raw);
    });
  });
}

function storageSet(data) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set(data, () => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(err.message));
      else resolve();
    });
  });
}

async function getEphemeralHosts() {
  try {
    const data = await chrome.storage.session.get(SESSION_EPHEMERAL_KEY);
    const map = data?.[SESSION_EPHEMERAL_KEY];
    return map && typeof map === "object" ? { ...map } : {};
  } catch {
    return {};
  }
}

async function setEphemeralHosts(ephemeralHosts) {
  await chrome.storage.session.set({ [SESSION_EPHEMERAL_KEY]: ephemeralHosts || {} });
}

function extensionVersion() {
  try {
    return String(chrome.runtime.getManifest()?.version || "");
  } catch {
    return "";
  }
}

async function publicState() {
  const state = await storageGet();
  const ephemeralHosts = await getEphemeralHosts();
  return {
    version: extensionVersion(),
    hours: state.hours,
    hostsText: state.hostsText,
    autoEnableOnTab: state.autoEnableOnTab,
    rows: buildHostRows({ ...state, ephemeralHosts }),
  };
}

function setBadge(text, color = "#6b7280") {
  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color });
}

async function syncBadge(state) {
  const ephemeralHosts = state.ephemeralHosts ?? (await getEphemeralHosts());
  const rows = buildHostRows({ ...state, ephemeralHosts });
  if (!rows.some((row) => row.enabled)) {
    setBadge("");
    return;
  }
  if (rows.some((row) => row.enabled && row.lastError)) {
    setBadge("!", "#b45309");
    return;
  }
  setBadge("");
}

function isPermanentHost(state, host) {
  return parseHostList(state.hostsText).includes(normalizeHost(host));
}

/** True only when each host origin is granted (needed for scripting IP tabs in Firefox). */
async function hasSpecificHostPermissions(hosts) {
  const origins = hosts.map(originForHost).filter(Boolean);
  if (!origins.length) return false;
  try {
    return await chrome.permissions.contains({ origins });
  } catch {
    return false;
  }
}

/**
 * Broad access check: specific host OR the https wildcard optional permission.
 * Do not use this before executeScript on IP tabs — Firefox often needs the specific origin.
 */
async function hasHostPermissions(hosts) {
  if (await hasSpecificHostPermissions(hosts)) return true;
  try {
    if (await chrome.permissions.contains({ origins: ["https://*/*"] })) return true;
  } catch {
    /* ignore */
  }
  return false;
}

function tabsQuery(query) {
  return new Promise((resolve, reject) => {
    chrome.tabs.query(query, (tabs) => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(err.message));
      else resolve(tabs || []);
    });
  });
}

function tabsGet(tabId) {
  return new Promise((resolve, reject) => {
    chrome.tabs.get(tabId, (tab) => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(err.message));
      else resolve(tab);
    });
  });
}

function tabsCreate(createProperties) {
  return new Promise((resolve, reject) => {
    chrome.tabs.create(createProperties, (tab) => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(err.message));
      else resolve(tab);
    });
  });
}

function tabsReload(tabId) {
  return new Promise((resolve, reject) => {
    chrome.tabs.reload(tabId, {}, () => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(err.message));
      else resolve();
    });
  });
}

function waitTabComplete(tabId, timeoutMs = 45000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      fn();
    };
    const timer = setTimeout(() => {
      finish(() => reject(new Error("SCM tab timed out")));
    }, timeoutMs);
    const onUpdated = (id, info, tab) => {
      if (id === tabId && info.status === "complete") finish(() => resolve(tab));
    };
    chrome.tabs.onUpdated.addListener(onUpdated);
    void tabsGet(tabId)
      .then((tab) => {
        if (tab.status === "complete") finish(() => resolve(tab));
      })
      .catch((err) => finish(() => reject(err)));
  });
}

function sendTabMessage(tabId, message) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(err.message));
      else resolve(response);
    });
  });
}

function pokeScmInPage() {
  const opts = { bubbles: true, cancelable: true, view: window, clientX: 6, clientY: 6 };
  const targets = [window, document, document.documentElement, document.body];
  for (const target of targets) {
    if (!target || typeof target.dispatchEvent !== "function") continue;
    target.dispatchEvent(new MouseEvent("mousemove", opts));
  }
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Shift", bubbles: true, cancelable: true }));
  document.dispatchEvent(new KeyboardEvent("keyup", { key: "Shift", bubbles: true, cancelable: true }));
  return String(location.href || "");
}

async function ensureScmTab(host) {
  const existing = await tabsQuery({ url: [`https://${host}/*`] });
  let tab = existing[0];
  if (tab?.discarded) {
    await tabsReload(tab.id);
    tab = await waitTabComplete(tab.id);
  } else if (tab && tab.status !== "complete") {
    tab = await waitTabComplete(tab.id);
  } else if (!tab) {
    tab = await tabsCreate({ url: `https://${host}/`, active: false });
    tab = await waitTabComplete(tab.id);
  }
  return tab;
}

async function pingScmHost(host) {
  const key = normalizeHost(host);
  const tab = await ensureScmTab(key);
  const url = tab?.url || `https://${key}/`;
  if (looksLikeScmLoginUrl(url)) {
    return { ok: false, host: key, url, reason: "SCM login expired — sign in again in this browser" };
  }
  let result;
  try {
    result = await sendTabMessage(tab.id, { type: "scm-poke" });
  } catch {
    const injected = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: "MAIN",
      func: pokeScmInPage,
    });
    const pageUrl = injected?.[0]?.result || url;
    result = looksLikeScmLoginUrl(pageUrl)
      ? { ok: false, reason: "SCM login expired — sign in again in this browser", url: pageUrl }
      : { ok: true, url: pageUrl };
  }
  if (result?.ok) return { ok: true, host: key, url: result.url || url };
  return {
    ok: false,
    host: key,
    url: result?.url || url,
    reason: result?.reason || "SCM login expired — sign in again in this browser",
  };
}

async function isEphemeralHost(host) {
  const key = normalizeHost(host);
  if (!key) return false;
  const ephemeralHosts = await getEphemeralHosts();
  const row = ephemeralHosts[key];
  return Boolean(row?.ephemeral || row?.untilManual);
}

/** Background cookie fetch — works for trusted certs (original manual-host path). */
async function pingPanOsBackground(host) {
  const key = normalizeHost(host);
  const paths = ["/", "/php/"];
  let lastUrl = "";
  let lastStatus = 0;
  let sawResponse = false;
  let fetchFailed = false;
  for (const path of paths) {
    try {
      const res = await fetch(`https://${key}${path}`, {
        method: "GET",
        credentials: "include",
        redirect: "follow",
        cache: "no-store",
        headers: { "Cache-Control": "no-cache", Pragma: "no-cache" },
      });
      sawResponse = true;
      lastUrl = res.url || `https://${key}${path}`;
      lastStatus = res.status;
      const lastBody = await res.text();
      if (isAuthenticatedPage(lastUrl, lastStatus, lastBody)) {
        return { ok: true, host: key, url: lastUrl, via: "background" };
      }
    } catch {
      fetchFailed = true;
    }
  }
  if (!sawResponse && fetchFailed) {
    return {
      ok: false,
      host: key,
      url: lastUrl || `https://${key}/`,
      via: "background",
      reason: "Failed to fetch — open the host tab (trust the cert) or allow host permission",
    };
  }
  return {
    ok: false,
    host: key,
    url: lastUrl,
    via: "background",
    reason: lastStatus >= 400 ? `HTTP ${lastStatus}` : "Panorama login expired — sign in again in this browser",
  };
}

async function pingHost(host) {
  const key = normalizeHost(host);
  if (isScmHost(key)) return pingScmHost(key);

  const ephemeral = await isEphemeralHost(key);

  // Session-only: open tab required; never spawn a replacement tab.
  if (ephemeral) {
    const tabPing = await keepAlivePanOsFromTab(key, {
      createIfMissing: false,
      ephemeralHint: true,
    });
    if (tabPing?.ok) return tabPing;
    if (!tabPing) {
      await endEphemeralSession(key);
      return {
        ok: false,
        host: key,
        url: `https://${key}/`,
        reason: "Session tab closed — Add this session again when you reopen it",
      };
    }
    return tabPing;
  }

  // Permanent hosts: background fetch first (valid-cert path that used to work), then in-tab
  // for self-signed / Not Secure when background cannot connect.
  const bg = await pingPanOsBackground(key);
  if (bg.ok) return bg;

  const tabPing = await keepAlivePanOsFromTab(key, {
    createIfMissing: false,
    ephemeralHint: false,
  });
  if (tabPing?.ok) return tabPing;

  if (bg.via === "background" && bg.reason && !/failed to fetch/i.test(bg.reason)) {
    return bg;
  }
  if (tabPing) return tabPing;
  return bg;
}

/** Prefer an already-open logged-in UI tab; url-pattern query alone misses some Firefox IP tabs. */
async function findTabsForHost(host) {
  const key = normalizeHost(host);
  if (!key) return [];
  const out = [];
  try {
    const tabs = await tabsQuery({});
    for (const tab of tabs || []) {
      if (hostFromTabUrl(tab?.url || "") === key) out.push(tab);
    }
  } catch {
    /* ignore */
  }
  if (out.length) return out;
  try {
    return (await tabsQuery({ url: [`https://${key}/*`, `https://${key}/`] })) || [];
  } catch {
    return [];
  }
}

function preferLoggedInTab(tabs) {
  const list = tabs || [];
  const scored = list.map((tab) => {
    const url = String(tab?.url || "");
    let score = 0;
    if (!/\/php\/login\.php|\/php\/logout\.php/i.test(url)) score += 5;
    if (/#(dashboard|device|monitor|network|objects|policies|acc|panorama)\b/i.test(url)) score += 3;
    if (tab.active) score += 1;
    return { tab, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored[0]?.tab || list[0] || null;
}

async function ensurePanOsTab(host) {
  const key = normalizeHost(host);
  let tab = preferLoggedInTab(await findTabsForHost(key));
  if (tab?.discarded) {
    await tabsReload(tab.id);
    tab = await waitTabComplete(tab.id);
  } else if (tab && tab.status !== "complete") {
    tab = await waitTabComplete(tab.id);
  } else if (!tab) {
    tab = await tabsCreate({ url: `https://${key}/`, active: false });
    tab = await waitTabComplete(tab.id);
  }
  return tab;
}

/**
 * Runs in the firewall/Panorama tab MAIN world.
 * PAN-OS resets admin Idle on management UI activity. X-Frame-Options: DENY blocks
 * iframes, so same-origin fetch + light UI nudges from the page are used instead.
 */
function panOsTabKeepAliveFunc() {
  const url = String(location.href || "");
  const html = String(document.documentElement?.outerHTML || "");
  const title = String(document.title || "");
  if (/logged out due to inactivity|you have been logged out/i.test(html)) {
    return Promise.resolve({ ok: false, authenticated: false, url, via: "idle-logout" });
  }
  const path = String(location.pathname || "").replace(/\/+$/, "") || "/";
  if (path === "/php/login.php" || path === "/php/logout.php") {
    return Promise.resolve({ ok: false, authenticated: false, url, via: "mgmt-path" });
  }
  const st = window.Pan && window.Pan.st && window.Pan.st.st;
  const token = st && st.st0;
  const hasSt0 =
    (typeof token === "string" && token) || /window\.Pan\.st\.st\.st0\s=\s"([^"]+)"/.test(html);
  const hash = String(location.hash || "");
  const hashShell =
    hash &&
    !/#?login\b/i.test(hash) &&
    /#(dashboard|device|monitor|network|objects|policies|acc|panorama)\b/i.test(hash);
  // Older/appliance UI paths like /php/gui/network/dashboard.php
  const guiShell = /^\/php\/gui\//i.test(path) && !/login/i.test(path);
  // Logged-in ExtJS chrome (footer shows Session Expire Time / Logout).
  const adminChrome =
    /Session Expire Time|Last Login Time/i.test(html) ||
    (/Logout/i.test(html) && /admin/i.test(html)) ||
    (/PA-VM|Palo Alto|PA-\d/i.test(title) && (hashShell || guiShell)) ||
    guiShell;
  if (!hasSt0 && !hashShell && !adminChrome && !guiShell && !(st && typeof st === "object")) {
    return Promise.resolve({ ok: false, authenticated: false, url, via: "no-token" });
  }

  const origin = String(location.origin || "");
  const ts = Date.now();
  const paths = [
    `/?_ka=${ts}`,
    `/php/?_ka=${ts}`,
    `/php/utils/status.php?_ka=${ts}`,
    `/php/utils/monitor.php?_ka=${ts}`,
    `/php/device/panorama/get.php?_ka=${ts}`,
  ];
  return (async () => {
    try {
      const opts = { bubbles: true, cancelable: true, view: window, clientX: 12, clientY: 12 };
      for (const target of [window, document, document.documentElement, document.body]) {
        if (!target || typeof target.dispatchEvent !== "function") continue;
        target.dispatchEvent(new MouseEvent("mousemove", opts));
        target.dispatchEvent(new MouseEvent("mousedown", opts));
        target.dispatchEvent(new MouseEvent("mouseup", opts));
      }
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Shift", bubbles: true }));
    } catch {
      /* ignore */
    }
    try {
      if (hashShell || (adminChrome && hash)) {
        const base = (hash || "#device").replace(/[?&]_ka=\d+/g, "");
        const next = `${base}${base.includes("?") ? "&" : "?"}_ka=${ts}`;
        history.replaceState(null, "", `${location.pathname}${location.search}${next}`);
        window.dispatchEvent(new Event("hashchange"));
      }
    } catch {
      /* ignore */
    }
    try {
      const pan = window.Pan;
      if (pan && pan.base && typeof pan.base.refresh === "function") pan.base.refresh();
    } catch {
      /* ignore */
    }
    let touched = false;
    let loginRedirects = 0;
    let lastFailUrl = url;
    for (const p of paths) {
      try {
        const res = await fetch(`${origin}${p}`, {
          method: "GET",
          credentials: "include",
          cache: "no-store",
          redirect: "follow",
          headers: { "Cache-Control": "no-cache", Pragma: "no-cache" },
        });
        const text = await res.text();
        const finalUrl = String(res.url || `${origin}${p}`);
        if (/\/php\/login\.php|\/php\/logout\.php/i.test(finalUrl)) {
          loginRedirects += 1;
          lastFailUrl = finalUrl;
          continue;
        }
        if (/logged out due to inactivity|you have been logged out/i.test(text)) {
          return { ok: false, authenticated: false, url: finalUrl, via: "fetch-idle-logout" };
        }
        if (res.ok || res.status === 200 || res.status === 304) {
          touched = true;
          break;
        }
        lastFailUrl = finalUrl;
      } catch {
        /* try next path */
      }
    }
    if (touched) {
      return { ok: true, authenticated: true, url, via: "fetch-php" };
    }
    // Do NOT treat "looks logged in" as a successful keep-alive — that skipped real refreshes
    // for permanent hosts and let Idle Timeout win. Caller may fall through to background fetch.
    if (loginRedirects > 0 && !adminChrome && !hashShell && !guiShell && !hasSt0) {
      return { ok: false, authenticated: false, url: lastFailUrl || url, via: "fetch-login" };
    }
    return {
      ok: false,
      authenticated: Boolean(adminChrome || hashShell || guiShell || hasSt0),
      url: lastFailUrl || url,
      via: "no-touch",
      reason: "Could not refresh session from tab",
    };
  })();
}

async function executePanOsTabScript(tabId, func, world = "MAIN") {
  const injected = await chrome.scripting.executeScript({
    target: { tabId },
    world,
    func,
  });
  return injected?.[0]?.result || null;
}

async function keepAlivePanOsFromTab(host, { createIfMissing = false, ephemeralHint = false } = {}) {
  const key = normalizeHost(host);
  if (!key) return null;
  const expiredReason = ephemeralHint
    ? "Firewall login expired — sign in again in this browser"
    : "Panorama login expired — sign in again in this browser";

  let tab = null;
  try {
    tab = preferLoggedInTab(await findTabsForHost(key));
    if (!tab && createIfMissing) {
      tab = await ensurePanOsTab(key);
    } else if (tab?.discarded) {
      await tabsReload(tab.id);
      tab = await waitTabComplete(tab.id);
    } else if (tab && tab.status !== "complete") {
      tab = await waitTabComplete(tab.id);
    }
  } catch {
    return null;
  }
  if (!tab?.id) return null;

  try {
    const result = await executePanOsTabScript(tab.id, panOsTabKeepAliveFunc);
    if (result?.authenticated && result?.ok) {
      return { ok: true, host: key, url: result.url || tab.url || `https://${key}/` };
    }
    if (result && (result.via === "idle-logout" || result.via === "mgmt-path" || result.via === "fetch-login" || result.via === "fetch-idle-logout")) {
      return {
        ok: false,
        host: key,
        url: result.url || tab.url || "",
        reason: expiredReason,
      };
    }
    if (result?.via === "no-token" || isPanOsMgmtUrl(result?.url || tab.url || "")) {
      return {
        ok: false,
        host: key,
        url: result?.url || tab.url || "",
        reason: expiredReason,
      };
    }
    if (result?.via === "no-touch" || (result && result.authenticated && !result.ok)) {
      return {
        ok: false,
        host: key,
        url: result.url || tab.url || "",
        reason: result.reason || "Could not refresh session from tab",
      };
    }
  } catch {
    return {
      ok: false,
      host: key,
      url: tab.url || `https://${key}/`,
      reason: "Could not run keep-alive in the open tab — reopen the popup and allow host access",
    };
  }
  return null;
}

async function pingEphemeralPanOsHost(host) {
  const key = normalizeHost(host);
  const tabPing = await keepAlivePanOsFromTab(key, { createIfMissing: false, ephemeralHint: true });
  if (tabPing) return tabPing;
  await endEphemeralSession(key);
  return {
    ok: false,
    host: key,
    url: `https://${key}/`,
    reason: "Session tab closed — Add this session again when you reopen it",
  };
}

function emitProgress(payload) {
  chrome.runtime.sendMessage({ type: "ping-progress", ...payload }, () => {
    void chrome.runtime.lastError;
  });
}

function progressKind(kind) {
  return kind === "connect" ? "connect" : "refresh";
}

function labelFor(state, host, ephemeralHosts = {}) {
  const key = normalizeHost(host);
  const alias = state?.hosts?.[key]?.alias || ephemeralHosts?.[key]?.alias || "";
  return hostLabel(key, alias);
}

function emitHostProgress(state, extra, ephemeralHosts = {}) {
  const host = extra.host || "";
  emitProgress({
    ...extra,
    host,
    label: labelFor(state, host, ephemeralHosts),
  });
}

async function listManagedHosts(state, ephemeralHosts) {
  const permanent = parseHostList(state.hostsText);
  const keys = [...permanent];
  for (const host of Object.keys(ephemeralHosts || {})) {
    const key = normalizeHost(host);
    if (key && !keys.includes(key)) keys.push(key);
  }
  return keys;
}

function rowForHost(state, ephemeralHosts, host) {
  const key = normalizeHost(host);
  if (isPermanentHost(state, key)) return { row: state.hosts[key], ephemeral: false };
  return { row: ephemeralHosts[key], ephemeral: true };
}

async function writeHostRow(state, ephemeralHosts, host, nextRow, ephemeral) {
  const key = normalizeHost(host);
  if (ephemeral) {
    if (nextRow == null) delete ephemeralHosts[key];
    else ephemeralHosts[key] = nextRow;
    await setEphemeralHosts(ephemeralHosts);
    return;
  }
  state.hosts[key] = nextRow;
  await storageSet({ hosts: state.hosts });
}

/**
 * Apply ping result. Session rows are removed when the tab is closed or keep-alive
 * is turned off; other refresh failures keep the row with an error note.
 */
function rowAfterPing(row, result, { ephemeral = false } = {}) {
  if (result?.ok) {
    return {
      ...row,
      lastOkAt: new Date().toISOString(),
      lastError: "",
    };
  }
  const reason = result?.reason || "Refresh failed";
  if (ephemeral && /session tab closed/i.test(reason)) {
    return null;
  }
  if (isLoginExpiredReason(reason)) {
    if (ephemeral) {
      return {
        ...row,
        enabled: true,
        untilManual: true,
        until: "",
        lastError: reason,
      };
    }
    return {
      ...row,
      enabled: false,
      until: "",
      untilManual: false,
      lastError: reason,
    };
  }
  return { ...row, lastError: reason };
}

async function refreshAll({ report = false, kind = "refresh" } = {}) {
  const state = await storageGet();
  const ephemeralHosts = await getEphemeralHosts();
  const now = Date.now();
  const managed = await listManagedHosts(state, ephemeralHosts);
  const queued = managed.filter((host) => {
    const { row } = rowForHost(state, ephemeralHosts, host);
    return isHostKeepAliveActive(row, now);
  });
  if (report) {
    emitHostProgress(
      state,
      {
        phase: "start",
        current: 0,
        total: queued.length,
        host: queued[0] || "",
        kind: progressKind(kind),
      },
      ephemeralHosts,
    );
  }
  let hostsChanged = false;
  let ephemeralChanged = false;
  let done = 0;
  for (const host of managed) {
    const { row, ephemeral } = rowForHost(state, ephemeralHosts, host);
    if (!isHostKeepAliveActive(row, now)) {
      if (row?.enabled && !row.untilManual) {
        const next = {
          ...row,
          enabled: false,
          lastError: isKeepAlivePingFailure(row.lastError) ? row.lastError : REASON_DURATION_ENDED,
        };
        if (ephemeral) {
          ephemeralHosts[host] = next;
          ephemeralChanged = true;
        } else {
          state.hosts[host] = next;
          hostsChanged = true;
        }
      }
      continue;
    }
    if (report) {
      emitHostProgress(
        state,
        {
          phase: "host",
          current: done,
          total: queued.length,
          host,
          kind: progressKind(kind),
        },
        ephemeralHosts,
      );
    }
    try {
      const result = await pingHost(host);
      const next = rowAfterPing(row, result, { ephemeral });
      if (ephemeral) {
        if (next == null) delete ephemeralHosts[host];
        else ephemeralHosts[host] = next;
        ephemeralChanged = true;
      } else {
        state.hosts[host] = next;
        hostsChanged = true;
      }
    } catch (err) {
      const next = rowAfterPing(
        row,
        { ok: false, reason: err instanceof Error ? err.message : String(err) },
        { ephemeral },
      );
      if (ephemeral) {
        if (next == null) delete ephemeralHosts[host];
        else ephemeralHosts[host] = next;
        ephemeralChanged = true;
      } else {
        state.hosts[host] = next;
        hostsChanged = true;
      }
    }
    done += 1;
    if (report) {
      emitHostProgress(
        state,
        {
          phase: "host-done",
          current: done,
          total: queued.length,
          host,
          kind: progressKind(kind),
        },
        ephemeralHosts,
      );
    }
  }
  if (hostsChanged) await storageSet({ hosts: state.hosts });
  if (ephemeralChanged) await setEphemeralHosts(ephemeralHosts);
  await syncBadge({ ...state, ephemeralHosts });
  await scheduleFromState({ ...state, ephemeralHosts });
}

async function refreshHost(host, { report = false, kind = "refresh" } = {}) {
  const key = normalizeHost(host);
  const state = await storageGet();
  const ephemeralHosts = await getEphemeralHosts();
  const { row, ephemeral } = rowForHost(state, ephemeralHosts, key);
  // User turned keep-alive off (or session ended) — do not open tabs mid-flight.
  if (ephemeral && !ephemeralHosts[key]) {
    const alarm = alarmNameForHost(key);
    if (alarm) {
      try {
        await chrome.alarms.clear(alarm);
      } catch {
        /* ignore */
      }
    }
    return { ok: true, state: await publicState() };
  }
  const progress = progressKind(kind);
  if (report) {
    emitHostProgress(
      state,
      { phase: "start", current: 0, total: 1, host: key, kind: progress },
      ephemeralHosts,
    );
    emitHostProgress(
      state,
      { phase: "host", current: 0, total: 1, host: key, kind: progress },
      ephemeralHosts,
    );
  }
  if (!isHostKeepAliveActive(row)) {
    if (row?.enabled && !row.untilManual) {
      const next = {
        ...row,
        enabled: false,
        lastError: isKeepAlivePingFailure(row.lastError) ? row.lastError : REASON_DURATION_ENDED,
      };
      await writeHostRow(state, ephemeralHosts, key, next, ephemeral);
    }
    await scheduleFromState({ ...state, ephemeralHosts });
    await syncBadge({ ...state, ephemeralHosts });
    if (report) {
      emitHostProgress(
        state,
        { phase: "done", current: 1, total: 1, host: key, kind: progress },
        ephemeralHosts,
      );
    }
    return;
  }
  try {
    const result = await pingHost(key);
    await writeHostRow(state, ephemeralHosts, key, rowAfterPing(row, result, { ephemeral }), ephemeral);
  } catch (err) {
    await writeHostRow(
      state,
      ephemeralHosts,
      key,
      rowAfterPing(
        row,
        { ok: false, reason: err instanceof Error ? err.message : String(err) },
        { ephemeral },
      ),
      ephemeral,
    );
  }
  const latestEphemeral = await getEphemeralHosts();
  await syncBadge({ ...state, ephemeralHosts: latestEphemeral });
  await scheduleFromState({ ...state, ephemeralHosts: latestEphemeral });
  if (report) {
    emitHostProgress(
      state,
      { phase: "host-done", current: 1, total: 1, host: key, kind: progress },
      latestEphemeral,
    );
    emitHostProgress(
      state,
      { phase: "done", current: 1, total: 1, host: key, kind: progress },
      latestEphemeral,
    );
  }
}

function getAllAlarms() {
  return new Promise((resolve) => {
    chrome.alarms.getAll((alarms) => resolve(alarms || []));
  });
}

async function clearKeepAliveAlarms() {
  const existing = await getAllAlarms();
  for (const alarm of existing) {
    const name = alarm.name || "";
    if (name === ALARM_NAME || name.startsWith(ALARM_PREFIX)) {
      await chrome.alarms.clear(name);
    }
  }
}

async function scheduleFromState(state) {
  const ephemeralHosts = state.ephemeralHosts ?? (await getEphemeralHosts());
  const wanted = new Map();
  const now = Date.now();
  for (const host of await listManagedHosts(state, ephemeralHosts)) {
    const { row } = rowForHost(state, ephemeralHosts, host);
    if (!isHostKeepAliveActive(row, now)) continue;
    const name = alarmNameForHost(host);
    if (name) wanted.set(name, clampIntervalMinutes(row.intervalMinutes));
  }
  const existing = await getAllAlarms();
  for (const alarm of existing) {
    const name = alarm.name || "";
    if (name !== ALARM_NAME && !name.startsWith(ALARM_PREFIX)) continue;
    const interval = wanted.get(name);
    if (!interval || alarm.periodInMinutes !== interval) {
      await chrome.alarms.clear(name);
    } else {
      wanted.delete(name);
    }
  }
  for (const [name, interval] of wanted) {
    // First fire ASAP (~1 min minimum). Waiting a full interval first loses the race
    // when Idle Timeout equals the refresh interval (e.g. both 5 min).
    chrome.alarms.create(name, {
      delayInMinutes: 1,
      periodInMinutes: interval,
    });
  }
  if (!anyHostActive(state.hostsText, state.hosts, ephemeralHosts, now)) {
    setBadge("");
  }
}

async function getAutoEnableSkip() {
  try {
    const data = await chrome.storage.session.get(SESSION_SKIP_KEY);
    const skip = data?.[SESSION_SKIP_KEY];
    return skip && typeof skip === "object" ? { ...skip } : {};
  } catch {
    return {};
  }
}

async function setAutoEnableSkip(host, skipped) {
  const key = normalizeHost(host);
  if (!key) return;
  const skip = await getAutoEnableSkip();
  if (skipped) skip[key] = true;
  else delete skip[key];
  try {
    await chrome.storage.session.set({ [SESSION_SKIP_KEY]: skip });
  } catch {
    /* ignore */
  }
}

async function anyOpenTabForHost(host) {
  const key = normalizeHost(host);
  if (!key) return false;
  try {
    const tabs = await findTabsForHost(key);
    return tabs.length > 0;
  } catch {
    return false;
  }
}

/** Drop a session-only host and its alarm; do not reopen tabs. */
async function endEphemeralSession(host) {
  const key = normalizeHost(host);
  if (!key) return;
  const ephemeralHosts = await getEphemeralHosts();
  if (!ephemeralHosts[key]) return;
  delete ephemeralHosts[key];
  await setEphemeralHosts(ephemeralHosts);
  await setAutoEnableSkip(key, true);
  const name = alarmNameForHost(key);
  if (name) {
    try {
      await chrome.alarms.clear(name);
    } catch {
      /* ignore */
    }
  }
  const state = await storageGet();
  await scheduleFromState({ ...state, ephemeralHosts });
  await syncBadge({ ...state, ephemeralHosts });
}

const autoEnableInFlight = new Set();

async function enableHostKeepAlive(host, { hours, intervalMinutes, report = false } = {}) {
  const key = normalizeHost(host);
  const state = await storageGet();
  const ephemeralHosts = await getEphemeralHosts();
  if (!key) return { ok: false, error: "Unknown host" };
  if (!(await hasHostPermissions([key]))) {
    return {
      ok: false,
      error: "Allow access to this host from the popup, then try again",
    };
  }
  if (isPermanentHost(state, key)) {
    const row = state.hosts[key] || {};
    const nextHours = clampHours(hours ?? state.hours);
    const nextInterval = clampIntervalMinutes(intervalMinutes ?? row.intervalMinutes);
    state.hosts[key] = {
      ...row,
      enabled: true,
      untilManual: false,
      ephemeral: false,
      intervalMinutes: nextInterval,
      until: new Date(Date.now() + nextHours * 60 * 60 * 1000).toISOString(),
      lastError: "",
    };
    await storageSet({ hours: nextHours, hosts: state.hosts });
    await setAutoEnableSkip(key, false);
    await scheduleFromState({ ...state, hours: nextHours, ephemeralHosts });
    await refreshHost(key, { report, kind: "connect" });
    return { ok: true, state: await publicState() };
  }
  if (!ephemeralHosts[key]) {
    return { ok: false, error: "Unknown host" };
  }
  ephemeralHosts[key] = {
    ...emptyEphemeralHostState(),
    ...ephemeralHosts[key],
    enabled: true,
    untilManual: true,
    until: "",
    lastError: "",
    intervalMinutes: clampIntervalMinutes(intervalMinutes ?? ephemeralHosts[key].intervalMinutes),
  };
  await setEphemeralHosts(ephemeralHosts);
  await setAutoEnableSkip(key, false);
  await scheduleFromState({ ...state, ephemeralHosts });
  await refreshHost(key, { report, kind: "connect" });
  return { ok: true, state: await publicState() };
}

async function disableHostKeepAlive(host, { hours } = {}) {
  const key = normalizeHost(host);
  const state = await storageGet();
  const ephemeralHosts = await getEphemeralHosts();
  if (!key) return { ok: false, error: "Unknown host" };
  const alarm = alarmNameForHost(key);
  if (alarm) {
    try {
      await chrome.alarms.clear(alarm);
    } catch {
      /* ignore */
    }
  }
  await setAutoEnableSkip(key, true);
  if (isPermanentHost(state, key)) {
    const row = state.hosts[key] || {};
    const nextHours = clampHours(hours ?? state.hours);
    state.hosts[key] = {
      ...row,
      enabled: false,
      until: "",
      untilManual: false,
      lastError: isKeepAlivePingFailure(row.lastError) ? row.lastError : REASON_TURNED_OFF,
    };
    await storageSet({ hours: nextHours, hosts: state.hosts });
    await scheduleFromState({ ...state, hours: nextHours, ephemeralHosts });
    await syncBadge({ ...state, hours: nextHours, ephemeralHosts });
    return { ok: true, state: await publicState() };
  }
  if (!ephemeralHosts[key]) {
    // Already gone (e.g. tab-close ended the session) — still report success.
    await scheduleFromState({ ...state, ephemeralHosts });
    await syncBadge({ ...state, ephemeralHosts });
    return { ok: true, state: await publicState() };
  }
  delete ephemeralHosts[key];
  await setEphemeralHosts(ephemeralHosts);
  await scheduleFromState({ ...state, ephemeralHosts });
  await syncBadge({ ...state, ephemeralHosts });
  return { ok: true, state: await publicState() };
}

function aliasFromTabTitle(alias, fallback = "") {
  const fromTitle = sanitizeAlias(alias);
  if (fromTitle && !/^login$/i.test(fromTitle)) return fromTitle;
  return sanitizeAlias(fallback) || "";
}

/** Session-only keep-alive — not written to Hosts; cleared when the browser closes. */
async function enableEphemeralTab(host, { intervalMinutes, alias = "", report = false } = {}) {
  const key = normalizeHost(host);
  if (!key) return { ok: false, error: "Unknown host" };
  if (!(await hasSpecificHostPermissions([key]))) {
    return { ok: false, error: "Allow access to this tab’s host when prompted" };
  }
  const state = await storageGet();
  if (isPermanentHost(state, key) || isScmHost(key)) {
    return enableHostKeepAlive(key, {
      hours: state.hours,
      intervalMinutes,
      report,
    });
  }
  const ephemeralHosts = await getEphemeralHosts();
  const prev = ephemeralHosts[key] || {};
  const nextAlias = aliasFromTabTitle(alias, prev.alias) || "This session";
  ephemeralHosts[key] = {
    ...emptyEphemeralHostState(),
    ...prev,
    enabled: true,
    untilManual: true,
    ephemeral: true,
    until: "",
    lastError: "",
    intervalMinutes: clampIntervalMinutes(intervalMinutes ?? prev.intervalMinutes),
    alias: nextAlias,
  };
  await setEphemeralHosts(ephemeralHosts);
  await setAutoEnableSkip(key, false);
  await scheduleFromState({ ...state, ephemeralHosts });
  try {
    await refreshHost(key, { report, kind: "connect" });
  } catch {
    /* row stays in session list even if the first refresh throws */
  }
  return { ok: true, state: await publicState() };
}

/** Save the active tab host under Hosts and enable keep-alive for Duration. */
async function addPermanentTab(host, { hours, intervalMinutes, alias = "", report = true } = {}) {
  const key = normalizeHost(host);
  if (!key) return { ok: false, error: "Unknown host" };
  if (!(await hasSpecificHostPermissions([key]))) {
    return { ok: false, error: "Allow access to this tab’s host when prompted" };
  }
  const state = await storageGet();
  const ephemeralHosts = await getEphemeralHosts();
  const nextAlias =
    aliasFromTabTitle(alias, state.hosts?.[key]?.alias || ephemeralHosts[key]?.alias || "") || "";

  if (ephemeralHosts[key]) {
    delete ephemeralHosts[key];
    await setEphemeralHosts(ephemeralHosts);
  }

  let hostsText = String(state.hostsText || "");
  const list = parseHostList(hostsText);
  if (!list.includes(key)) {
    const line = nextAlias ? `${key} ${nextAlias}` : key;
    hostsText = [hostsText.trim(), line].filter(Boolean).join("\n");
  }
  const hosts = mergeHostMap(hostsText, state.hosts);
  if (nextAlias) {
    hosts[key] = { ...(hosts[key] || {}), alias: nextAlias };
  }
  hostsText = serializeHostsText(hostsText, hosts);
  await storageSet({ hostsText, hosts });

  return enableHostKeepAlive(key, {
    hours: hours ?? state.hours,
    intervalMinutes,
    report,
  });
}

async function maybeAutoEnableFromTabUrl(url) {
  await sessionReady;
  const state = await storageGet();
  if (!state.autoEnableOnTab) return;
  const host = matchConfiguredHostFromTab(url, parseHostList(state.hostsText));
  if (!host) return;
  if (isHostKeepAliveActive(state.hosts[host])) return;
  const skip = await getAutoEnableSkip();
  if (skip[host]) return;
  if (autoEnableInFlight.has(host)) return;
  if (!(await hasHostPermissions([host]))) return;
  autoEnableInFlight.add(host);
  try {
    await enableHostKeepAlive(host, {
      hours: state.hours,
      intervalMinutes: state.hosts[host]?.intervalMinutes,
      report: false,
    });
  } catch {
    /* ignore transient tab/permission races */
  } finally {
    autoEnableInFlight.delete(host);
  }
}

async function clearAutoEnableSkipIfNoTabs(host) {
  const key = normalizeHost(host);
  if (!key) return;
  const skip = await getAutoEnableSkip();
  if (!skip[key]) return;
  if (await anyOpenTabForHost(key)) return;
  await setAutoEnableSkip(key, false);
}

chrome.runtime.onInstalled.addListener(() => {
  void (async () => {
    await sessionReady;
    // Drop legacy auto-recognize setting if present.
    try {
      await chrome.storage.local.remove("recognizePanFirewall");
    } catch {
      /* ignore */
    }
    // Recreate alarms so first refresh is ~1 min, not a full interval after upgrades.
    await clearKeepAliveAlarms();
    const state = await storageGet();
    const ephemeralHosts = await getEphemeralHosts();
    await scheduleFromState({ ...state, ephemeralHosts });
    await syncBadge({ ...state, ephemeralHosts });
  })();
});

chrome.runtime.onStartup.addListener(() => {
  void (async () => {
    await sessionReady;
    const state = await storageGet();
    await scheduleFromState(state);
    await syncBadge(state);
  })();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  const host = hostFromAlarmName(alarm.name);
  if (!host) return;
  void (async () => {
    await sessionReady;
    await refreshHost(host);
  })();
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete" && !changeInfo.url) return;
  const url = changeInfo.url || tab?.url || "";
  if (!url) return;
  void maybeAutoEnableFromTabUrl(url);
});

chrome.tabs.onRemoved.addListener((_tabId, _removeInfo) => {
  void (async () => {
    await sessionReady;
    const ephemeralHosts = await getEphemeralHosts();
    for (const host of Object.keys(ephemeralHosts)) {
      if (!(await anyOpenTabForHost(host))) {
        await endEphemeralSession(host);
      }
    }
    const state = await storageGet();
    if (!state.autoEnableOnTab) return;
    for (const host of parseHostList(state.hostsText)) {
      await clearAutoEnableSkipIfNoTabs(host);
    }
  })();
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  void (async () => {
    try {
      await sessionReady;
      if (message?.type === "get-state") {
        const state = await publicState();
        const needHostPermissions = [];
        const seenNeed = new Set();
        for (const row of state.rows || []) {
          const key = normalizeHost(row.host);
          if (!key || seenNeed.has(key) || isScmHost(key)) continue;
          if (await hasSpecificHostPermissions([key])) continue;
          seenNeed.add(key);
          needHostPermissions.push(key);
        }
        sendResponse({ ok: true, state, needHostPermissions });
        return;
      }
      if (message?.type === "add-ephemeral-tab") {
        const host = normalizeHost(message.host);
        if (!host) {
          sendResponse({ ok: false, error: "Open an https:// Panorama or firewall tab first" });
          return;
        }
        sendResponse(
          await enableEphemeralTab(host, {
            intervalMinutes: message.intervalMinutes,
            alias: message.title || message.alias || "",
            report: true,
          }),
        );
        return;
      }
      if (message?.type === "add-permanent-tab") {
        const host = normalizeHost(message.host);
        if (!host) {
          sendResponse({ ok: false, error: "Open an https:// Panorama or firewall tab first" });
          return;
        }
        sendResponse(
          await addPermanentTab(host, {
            hours: message.hours,
            intervalMinutes: message.intervalMinutes,
            alias: message.title || message.alias || "",
            report: true,
          }),
        );
        return;
      }
      if (message?.type === "save-hosts") {
        const current = await storageGet();
        const hosts = mergeHostMap(String(message.hostsText || ""), current.hosts);
        const hostList = parseHostList(message.hostsText);
        if (hostList.length && !(await hasHostPermissions(hostList))) {
          sendResponse({
            ok: false,
            error: "Allow Edge access to those Panorama hosts when prompted, then save again",
          });
          return;
        }
        const hostsText = serializeHostsText(message.hostsText, hosts);
        await storageSet({ hostsText, hosts });
        sendResponse({ ok: true, hosts: hostList, state: await publicState() });
        return;
      }
      if (message?.type === "set-hours") {
        await storageSet({ hours: clampHours(message.hours) });
        sendResponse({ ok: true, state: await publicState() });
        return;
      }
      if (message?.type === "set-auto-enable-on-tab") {
        const autoEnableOnTab = Boolean(message.autoEnableOnTab);
        await storageSet({ autoEnableOnTab });
        if (autoEnableOnTab) {
          try {
            const tabs = await tabsQuery({});
            for (const tab of tabs || []) {
              if (tab?.url) await maybeAutoEnableFromTabUrl(tab.url);
            }
          } catch {
            /* ignore */
          }
        }
        sendResponse({ ok: true, state: await publicState() });
        return;
      }
      if (message?.type === "set-host-enabled") {
        const host = normalizeHost(message.host);
        const enabled = Boolean(message.enabled);
        const hours = clampHours(message.hours);
        if (enabled) {
          const state = await storageGet();
          const ephemeralHosts = await getEphemeralHosts();
          if (isPermanentHost(state, host) || isScmHost(host)) {
            sendResponse(
              await enableHostKeepAlive(host, {
                hours,
                intervalMinutes: message.intervalMinutes,
                report: true,
              }),
            );
            return;
          }
          if (ephemeralHosts[host]) {
            sendResponse(
              await enableEphemeralTab(host, {
                intervalMinutes: message.intervalMinutes,
                report: true,
              }),
            );
            return;
          }
          sendResponse({ ok: false, error: "Unknown host — use Add this tab for session keep-alive" });
          return;
        }
        sendResponse(await disableHostKeepAlive(host, { hours }));
        return;
      }
      if (message?.type === "set-host-alias") {
        const host = normalizeHost(message.host);
        const alias = sanitizeAlias(message.alias);
        const state = await storageGet();
        const ephemeralHosts = await getEphemeralHosts();
        if (isPermanentHost(state, host)) {
          const row = state.hosts[host] || {};
          state.hosts[host] = { ...row, alias };
          const hostsText = serializeHostsText(state.hostsText, state.hosts);
          await storageSet({ hosts: state.hosts, hostsText });
          sendResponse({ ok: true, state: await publicState() });
          return;
        }
        if (ephemeralHosts[host]) {
          ephemeralHosts[host] = { ...ephemeralHosts[host], alias };
          await setEphemeralHosts(ephemeralHosts);
          sendResponse({ ok: true, state: await publicState() });
          return;
        }
        sendResponse({ ok: false, error: "Unknown host" });
        return;
      }
      if (message?.type === "set-host-interval") {
        const host = normalizeHost(message.host);
        const intervalMinutes = clampIntervalMinutes(message.intervalMinutes);
        const state = await storageGet();
        const ephemeralHosts = await getEphemeralHosts();
        if (isPermanentHost(state, host)) {
          const row = state.hosts[host] || {};
          state.hosts[host] = { ...row, intervalMinutes };
          await storageSet({ hosts: state.hosts });
          await scheduleFromState({ ...state, ephemeralHosts });
          sendResponse({ ok: true, state: await publicState() });
          return;
        }
        if (ephemeralHosts[host]) {
          ephemeralHosts[host] = { ...ephemeralHosts[host], intervalMinutes };
          await setEphemeralHosts(ephemeralHosts);
          await scheduleFromState({ ...state, ephemeralHosts });
          sendResponse({ ok: true, state: await publicState() });
          return;
        }
        sendResponse({ ok: false, error: "Unknown host" });
        return;
      }
      if (message?.type === "ping-now") {
        await refreshAll({ report: true, kind: "refresh" });
        emitProgress({ phase: "done", current: 1, total: 1, host: "", kind: "refresh" });
        sendResponse({ ok: true, state: await publicState() });
        return;
      }
      sendResponse({
        ok: false,
        error:
          "Unknown message — reload this extension on edge://extensions (or about:addons), then try Add this tab again",
        version: extensionVersion(),
      });
    } catch (err) {
      sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  })();
  return true;
});
