import {
  ALIAS_MAX_LENGTH,
  INTERVAL_OPTIONS,
  REASON_TURNED_OFF,
  connectingNote,
  hostFromTabUrl,
} from "./keepalive.js";
import { requestHostPermissions } from "./permissions.js";

const hoursEl = document.getElementById("hours");
const autoEnableEl = document.getElementById("auto-enable");
const hostsEl = document.getElementById("hosts");
const emptyEl = document.getElementById("empty");
const statusEl = document.getElementById("status");
const addTabEl = document.getElementById("add-tab");
const pingEl = document.getElementById("ping");
const optionsEl = document.getElementById("options");
const progressEl = document.getElementById("progress");
const progressBarEl = document.getElementById("progress-bar");
const progressLabelEl = document.getElementById("progress-label");

let lastState = null;

function send(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(err.message));
      else resolve(response);
    });
  });
}

function formatTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString(undefined, { hour: "numeric", minute: "2-digit" });
}

function showError(message) {
  statusEl.textContent = message || "";
  statusEl.classList.toggle("is-error", Boolean(message));
}

function hostNote(item) {
  let note = item.querySelector(".host-note");
  if (note) return note;
  note = document.createElement("span");
  note.className = "host-note";
  item.append(note);
  return note;
}

function startConnecting(item, host, label, kind = "panorama") {
  const status = item.querySelector(".host-status");
  const note = hostNote(item);
  const box = item.querySelector("input[type='checkbox']");
  const intervalEl = item.querySelector("select[data-interval]");
  const aliasEl = item.querySelector(".host-alias");
  item.classList.add("is-connecting");
  if (box) box.disabled = true;
  if (intervalEl) intervalEl.disabled = true;
  if (aliasEl) aliasEl.disabled = true;
  if (status) {
    status.className = "host-status is-connecting";
    status.textContent = "Connecting…";
  }
  let seconds = 0;
  const tick = () => {
    note.className = "host-note";
    note.textContent = connectingNote(seconds, kind);
    seconds += 1;
  };
  tick();
  const timer = window.setInterval(tick, 1000);
  setProgress({
    phase: "host",
    current: 0,
    total: 1,
    host,
    label: label || host,
    kind: "connect",
  });
  return () => {
    window.clearInterval(timer);
    item.classList.remove("is-connecting");
    if (box) box.disabled = false;
    if (intervalEl) intervalEl.disabled = false;
    if (aliasEl) aliasEl.disabled = false;
  };
}

function setProgress({ current = 0, total = 0, host = "", label = "", phase = "", kind = "refresh" } = {}) {
  const running = phase !== "done";
  progressEl.hidden = !running && phase !== "done";
  progressEl.classList.toggle("is-busy", running);
  const verb = kind === "connect" ? "Connecting" : "Refreshing";
  const name = label || host;
  if (phase === "done") {
    progressEl.classList.remove("is-busy");
    progressBarEl.style.width = "100%";
    progressLabelEl.textContent = kind === "connect" ? "Connected" : "Refresh complete";
    return;
  }
  if (!total) {
    progressBarEl.style.width = "12%";
    progressLabelEl.textContent = `${verb}…`;
    return;
  }
  const pct = Math.max(8, Math.round(((current + (phase === "host-done" ? 0 : 0.45)) / total) * 100));
  progressBarEl.style.width = `${Math.min(pct, 92)}%`;
  const n = Math.min(current + (phase === "host-done" ? 0 : 1), total);
  progressLabelEl.textContent = name
    ? `${verb} ${name} (${n} of ${total})`
    : `${verb} (${n} of ${total})`;
}

function hideProgress() {
  progressEl.hidden = true;
  progressEl.classList.remove("is-busy");
  progressBarEl.style.width = "0";
  progressLabelEl.textContent = "";
}

function render(state) {
  lastState = state;
  hoursEl.value = String(state.hours || 8);
  autoEnableEl.checked = Boolean(state.autoEnableOnTab);
  const rows = Array.isArray(state.rows) ? state.rows : [];
  emptyEl.hidden = rows.length > 0;
  hostsEl.replaceChildren();
  for (const row of rows) {
    const item = document.createElement("div");
    item.className = "host";

    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = Boolean(row.enabled);
    box.dataset.host = row.host;
    box.addEventListener("change", () => {
      const intervalEl = item.querySelector("select[data-interval]");
      const permissionPromise = box.checked
        ? requestHostPermissions([row.host])
        : Promise.resolve(true);
      void setHostEnabled(
        item,
        row.host,
        box.checked,
        permissionPromise,
        Number(intervalEl?.value || row.intervalMinutes),
      );
    });

    const id = document.createElement("div");
    id.className = "host-id";

    const aliasEl = document.createElement("input");
    aliasEl.type = "text";
    aliasEl.className = "host-alias";
    aliasEl.maxLength = ALIAS_MAX_LENGTH;
    aliasEl.autocomplete = "off";
    aliasEl.spellcheck = false;
    aliasEl.value = row.alias || "";
    aliasEl.hidden = !row.alias;
    aliasEl.title = "Friendly name for this host";
    aliasEl.addEventListener("click", (ev) => ev.stopPropagation());
    aliasEl.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") {
        ev.preventDefault();
        aliasEl.blur();
      }
      if (ev.key === "Escape") {
        ev.preventDefault();
        aliasEl.value = row.alias || "";
        aliasEl.blur();
      }
    });
    aliasEl.addEventListener("blur", () => {
      const next = aliasEl.value.trim();
      aliasEl.hidden = !next;
      name.classList.toggle("is-primary", !next);
      void saveAlias(row.host, next);
    });

    const name = document.createElement("span");
    name.className = row.alias ? "host-name" : "host-name is-primary";
    name.textContent = row.host;
    name.title = row.alias ? row.host : "Click to name this host";
    name.addEventListener("click", () => {
      aliasEl.hidden = false;
      name.classList.remove("is-primary");
      aliasEl.focus();
      aliasEl.select();
    });
    id.append(aliasEl, name);

    const status = document.createElement("span");
    status.className = `host-status ${row.enabled ? "is-active" : "is-inactive"}`;
    status.textContent =
      row.kind === "scm"
        ? `${row.status} · SCM`
        : row.ephemeral
          ? `${row.status} · session`
          : row.status;

    const intervalWrap = document.createElement("label");
    intervalWrap.className = "host-interval";
    intervalWrap.append("every ");
    const intervalEl = document.createElement("select");
    intervalEl.dataset.interval = "1";
    for (const minutes of INTERVAL_OPTIONS) {
      const option = document.createElement("option");
      option.value = String(minutes);
      option.textContent = `${minutes} min`;
      intervalEl.append(option);
    }
    intervalEl.value = String(row.intervalMinutes || 10);
    intervalEl.addEventListener("change", () => {
      void send({
        type: "set-host-interval",
        host: row.host,
        intervalMinutes: Number(intervalEl.value),
      }).then((res) => {
        if (res?.ok) render(res.state);
        else showError(res?.error || "Could not save interval");
      });
    });
    intervalWrap.append(intervalEl);

    item.append(box, id, status, intervalWrap);

    if (row.lastError) {
      const note = document.createElement("span");
      note.className =
        row.lastError === REASON_TURNED_OFF ? "host-note is-muted" : "host-note is-error";
      note.textContent = row.lastError;
      item.append(note);
    }
    if (row.lastOkAt) {
      const note = document.createElement("span");
      note.className = "host-note";
      note.textContent = `Last refresh ${formatTime(row.lastOkAt)}`;
      item.append(note);
    }
    if (row.enabled && row.untilManual) {
      const note = document.createElement("span");
      note.className = "host-note";
      note.textContent = row.ephemeral
        ? "Session only — not saved in Hosts"
        : "Until you turn it off";
      item.append(note);
    } else if (row.enabled && row.until) {
      const note = document.createElement("span");
      note.className = "host-note";
      note.textContent = `Ends ${formatTime(row.until)}`;
      item.append(note);
    }
    hostsEl.append(item);
  }
}

async function load() {
  let res = await send({ type: "get-state" });
  if (!res?.ok) throw new Error(res?.error || "Could not read state");
  // Firefox needs per-host grants for scripting IP tabs used by keep-alive.
  const needed = Array.isArray(res.needHostPermissions) ? res.needHostPermissions : [];
  if (needed.length) {
    const granted = await requestHostPermissions(needed);
    if (granted) {
      res = await send({ type: "get-state" });
      if (!res?.ok) throw new Error(res?.error || "Could not read state");
    }
  }
  render(res.state);
}

async function addCurrentTab() {
  showError("");
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs?.[0];
  const host = hostFromTabUrl(tab?.url || "");
  if (!host) {
    showError("Switch to an https:// Panorama or firewall tab, then try again");
    return;
  }
  const granted = await requestHostPermissions([host]);
  if (!granted) {
    showError(`Allow access to ${host}, then Add this tab again`);
    return;
  }
  setProgress({
    phase: "host",
    current: 0,
    total: 1,
    host,
    label: host,
    kind: "connect",
  });
  const res = await send({
    type: "add-ephemeral-tab",
    host,
    tabId: tab.id,
    title: tab.title || "",
    hours: Number(hoursEl.value),
  });
  if (!res?.ok) {
    hideProgress();
    showError(res?.error || "Could not add this tab");
    return;
  }
  setProgress({ phase: "done", current: 1, total: 1, host, kind: "connect" });
  render(res.state);
  window.setTimeout(hideProgress, 700);
}

async function saveAlias(host, alias) {
  const previous = lastState?.rows?.find((row) => row.host === host)?.alias || "";
  const next = String(alias || "").trim();
  if (next === previous) return;
  try {
    const res = await send({ type: "set-host-alias", host, alias: next });
    if (!res?.ok) {
      showError(res?.error || "Could not save alias");
      if (lastState) render(lastState);
      return;
    }
    lastState = res.state;
  } catch (err) {
    showError(err instanceof Error ? err.message : String(err));
    if (lastState) render(lastState);
  }
}

async function setHostEnabled(item, host, enabled, permissionPromise, intervalMinutes) {
  const stopConnecting = enabled
    ? startConnecting(
        item,
        host,
        item.querySelector(".host-alias")?.value || host,
        lastState?.rows?.find((row) => row.host === host)?.kind || "panorama",
      )
    : () => {};
  try {
    if (enabled) {
      const granted = await (permissionPromise ?? requestHostPermissions([host]));
      if (!granted) {
        stopConnecting();
        if (lastState) render(lastState);
        showError("Allow access to this host, then enable again");
        return;
      }
    }
    const res = await send({
      type: "set-host-enabled",
      host,
      enabled,
      hours: Number(hoursEl.value),
      intervalMinutes,
    });
    stopConnecting();
    if (!res?.ok) {
      if (lastState) render(lastState);
      showError(res?.error || "Could not update keep-alive");
      return;
    }
    showError("");
    if (enabled) {
      setProgress({ phase: "done", current: 1, total: 1, host, kind: "connect" });
      render(res.state);
      window.setTimeout(hideProgress, 700);
    } else {
      hideProgress();
      render(res.state);
    }
  } catch (err) {
    stopConnecting();
    if (lastState) render(lastState);
    showError(err instanceof Error ? err.message : String(err));
  }
}

hoursEl.addEventListener("change", () => {
  void send({ type: "set-hours", hours: Number(hoursEl.value) });
});

autoEnableEl.addEventListener("change", () => {
  void (async () => {
    try {
      const res = await send({
        type: "set-auto-enable-on-tab",
        autoEnableOnTab: autoEnableEl.checked,
      });
      if (res?.ok) {
        showError("");
        render(res.state);
      } else {
        autoEnableEl.checked = Boolean(lastState?.autoEnableOnTab);
        showError(res?.error || "Could not save auto-enable");
      }
    } catch (err) {
      autoEnableEl.checked = Boolean(lastState?.autoEnableOnTab);
      showError(err instanceof Error ? err.message : String(err));
    }
  })();
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type !== "ping-progress") return;
  setProgress(message);
});

addTabEl.addEventListener("click", () => {
  void (async () => {
    addTabEl.disabled = true;
    try {
      await addCurrentTab();
    } catch (err) {
      hideProgress();
      showError(err instanceof Error ? err.message : String(err));
    } finally {
      addTabEl.disabled = false;
    }
  })();
});

pingEl.addEventListener("click", () => {
  void (async () => {
    pingEl.disabled = true;
    showError("");
    setProgress({ phase: "start", current: 0, total: 0, host: "", kind: "refresh" });
    try {
      const res = await send({ type: "ping-now" });
      if (res?.ok) {
        setProgress({ phase: "done", current: 1, total: 1, host: "", kind: "refresh" });
        render(res.state);
        window.setTimeout(hideProgress, 700);
      } else {
        hideProgress();
        showError(res?.error || "Refresh failed");
      }
    } catch (err) {
      hideProgress();
      showError(err instanceof Error ? err.message : String(err));
    } finally {
      pingEl.disabled = false;
    }
  })();
});

optionsEl.addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

void load().catch((err) => {
  showError(err instanceof Error ? err.message : String(err));
});
