# Panorama Keep-Alive

Browser extension (Edge / Chrome / Firefox) that quietly refreshes an existing Palo Alto **Panorama**, **firewall**, or **Strata Cloud Manager** web login so idle timers do not log you out.

Uses cookies already in the browser. Does **not** store a password.

Current version: **0.1.31**

## Share / install

### Firefox

1. Download the signed `.xpi` from the latest [GitHub Release](https://github.com/thrtnastrx/panorama-keepalive-extension/releases)
2. Open Firefox → **about:addons** → gear → **Install Add-on From File…**
3. Choose the `.xpi` → **Add**

Or open the `.xpi` file directly in Firefox.

### Edge / Chrome (Load unpacked)

1. Clone or download this repo
2. Open `edge://extensions` or `chrome://extensions`
3. Turn on **Developer mode**
4. **Load unpacked** → select this folder (the one with `manifest.json`)
5. Pin the extension, open **Hosts…**, add Panorama FQDNs, enable keep-alive

After a code update, click **Reload** on the extension card (required on Edge/Chrome — the popup can update while a stale background worker still runs; that shows **Unknown message** on Add this tab).

## Requirements

- You must already be logged into Panorama, the firewall, or SCM in **this** browser
- **"Not Secure" / self-signed certs:** background Panorama refresh often fails (`Failed to fetch`). Session keep-alive uses the open tab after you have clicked through the warning — leave the logged-in UI tab open

## Options (popup)

- **Duration** — how long keep-alive runs for saved hosts (1–24 hours)
- **Auto-enable** — turn on when you open a matching **saved** Panorama/SCM tab (host permission must already be allowed)
- **Add this session** — session-only keep-alive for the active tab (not saved under Hosts; cleared when the browser closes)
- **Add this tab to hosts** — save the active tab under Hosts and enable keep-alive for **Duration**
- **Hosts…** — edit the permanent host list (survives browser restart; Active still clears on close)

## Behavior

- **Saved hosts:** background `GET` of the UI (`/` and `/php/`), or in-tab refresh when a tab is open
- **SCM:** pokes an SCM tab (opens one in the background if needed)
- **Add this session:** keep-alive runs inside the open UI tab; not written to Hosts
- First refresh fires within ~1 minute (not after a full interval) so a 5‑minute Idle Timeout is not lost to the first alarm
- Use a refresh interval **shorter** than the device Idle Timeout
- Closing the browser clears Active checks and sessions; permanent hosts/aliases/intervals stay
- Does not beat Max Session Time or Duo lifetime

## Privacy

No account data collected. Settings stay on the device. Requests go only to hosts you enable.

## Develop

```bash
node --test tests/keepalive.test.mjs
```

Firefox temporary load: `about:debugging#/runtime/this-firefox` → **Load Temporary Add-on** → `manifest.json`.

Signing (maintainers): AMO JWT in local `.amo.env` (gitignored), then `npx web-ext sign --channel=unlisted`.
