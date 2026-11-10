import { parseHostList } from "./keepalive.js";
import { requestHostPermissions } from "./permissions.js";

const hostsEl = document.getElementById("hosts");
const statusEl = document.getElementById("status");
const form = document.getElementById("opts");

function send(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(err.message));
      else resolve(response);
    });
  });
}

async function load() {
  const res = await send({ type: "get-state" });
  if (!res?.ok) throw new Error(res?.error || "Could not read settings");
  hostsEl.value = String(res.state.hostsText || "");
}

async function save(ev, permissionPromise) {
  ev.preventDefault();
  statusEl.classList.remove("is-error");
  try {
    const hosts = parseHostList(hostsEl.value);
    const granted = await (permissionPromise ?? requestHostPermissions(hosts));
    if (!granted) throw new Error("Allow Edge access to those Panorama hosts, then save again");
    const res = await send({ type: "save-hosts", hostsText: hostsEl.value });
    if (!res?.ok) throw new Error(res?.error || "Save failed");
    hostsEl.value = String(res.state?.hostsText || (res.hosts || []).join("\n"));
    statusEl.textContent = res.hosts?.length ? `Saved ${res.hosts.length} host(s).` : "Saved — add at least one host.";
  } catch (err) {
    statusEl.textContent = err instanceof Error ? err.message : String(err);
    statusEl.classList.add("is-error");
  }
}

void load().catch((err) => {
  statusEl.textContent = err instanceof Error ? err.message : String(err);
  statusEl.classList.add("is-error");
});
form.addEventListener("submit", (e) => {
  const permissionPromise = requestHostPermissions(parseHostList(hostsEl.value));
  void save(e, permissionPromise);
});
