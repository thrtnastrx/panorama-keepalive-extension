/** Runs in the SCM tab. Synthetic events may not reset idle if the page ignores untrusted input. */

function pokeScmActivity() {
  const opts = { bubbles: true, cancelable: true, view: window, clientX: 6, clientY: 6 };
  const targets = [window, document, document.documentElement, document.body];
  for (const target of targets) {
    if (!target || typeof target.dispatchEvent !== "function") continue;
    target.dispatchEvent(new MouseEvent("mousemove", opts));
    if (typeof PointerEvent === "function") {
      target.dispatchEvent(new PointerEvent("pointermove", opts));
    }
  }
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Shift", bubbles: true, cancelable: true }));
  document.dispatchEvent(new KeyboardEvent("keyup", { key: "Shift", bubbles: true, cancelable: true }));
}

function scmPokeResult() {
  const url = String(location.href || "");
  if (/identity\.paloaltonetworks|login\.microsoftonline|auth\.apps\.paloaltonetworks|sso\.paloaltonetworks/i.test(url)) {
    return { ok: false, reason: "SCM login expired — sign in again in this browser", url };
  }
  pokeScmActivity();
  return { ok: true, url };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "scm-poke") return;
  sendResponse(scmPokeResult());
});
