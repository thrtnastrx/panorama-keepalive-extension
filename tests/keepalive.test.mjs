import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  alarmNameForHost,
  buildHostRows,
  clampHours,
  clampIntervalMinutes,
  hostFromAlarmName,
  isAuthenticatedPage,
  looksLikeLoginPage,
  mergeHostMap,
  normalizeHost,
  originForHost,
  parseHostList,
  remainingMs,
  connectingNote,
  parseHostLine,
  parseHostEntries,
  serializeHostEntries,
  hostLabel,
  hostStatusReason,
  isScmHost,
  looksLikeScmLoginUrl,
  matchConfiguredHostFromTab,
  hostFromTabUrl,
  looksLikePanOsUi,
  isPanOsLoginUrl,
  isPanOsMgmtUrl,
  isHostKeepAliveActive,
  SCM_HOST,
  REASON_DURATION_ENDED,
  REASON_TURNED_OFF,
  deactivateAllHosts,
} from "../keepalive.js";

describe("normalizeHost", () => {
  it("strips scheme, path, and port", () => {
    assert.equal(normalizeHost("https://Panorama-Skypath.inbcu.com/php/"), "panorama-skypath.inbcu.com");
    assert.equal(normalizeHost("panorama.example.com:443"), "panorama.example.com");
  });
});

describe("parseHostList", () => {
  it("dedupes and skips blanks", () => {
    assert.deepEqual(
      parseHostList("pano.example.com\n\nhttps://pano.example.com/\nother.example.com"),
      ["pano.example.com", "other.example.com", SCM_HOST],
    );
  });
});

describe("originForHost", () => {
  it("builds an optional-permission origin", () => {
    assert.equal(originForHost("pano.example.com"), "https://pano.example.com/*");
  });
});

describe("login detection", () => {
  it("treats login.php as expired", () => {
    assert.equal(looksLikeLoginPage("https://pano.example.com/php/login.php", "<html>"), true);
    assert.equal(isAuthenticatedPage("https://pano.example.com/php/login.php", 200, "<html>"), false);
  });

  it("treats logout.php and idle-timeout copy as expired", () => {
    assert.equal(looksLikeLoginPage("https://pano.example.com/php/logout.php?vl=2", "<html>"), true);
    assert.equal(
      isAuthenticatedPage(
        "https://pano.example.com/",
        200,
        "<html>You have been logged out due to inactivity.</html>",
      ),
      false,
    );
  });

  it("accepts a dashboard page with ServerToken", () => {
    const body = 'window.Pan.st.st.st0 = "tok123"';
    assert.equal(isAuthenticatedPage("https://pano.example.com/", 200, body), true);
  });

  it("rejects a login form served at /", () => {
    const body = '<form><input name="user"><input name="passwd">Log In</form>';
    assert.equal(isAuthenticatedPage("https://pano.example.com/", 200, body), false);
  });
});

describe("hours and remaining", () => {
  it("clamps to allowed values", () => {
    assert.equal(clampHours(4), 4);
    assert.equal(clampHours("nope"), 8);
  });

  it("computes remaining time", () => {
    const until = new Date(Date.now() + 90 * 60 * 1000).toISOString();
    assert.ok(remainingMs(until) > 80 * 60 * 1000);
    assert.equal(remainingMs("2000-01-01T00:00:00.000Z"), 0);
  });
});

describe("host rows", () => {
  it("lists one configured host per line with Active or Inactive", () => {
    const until = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const rows = buildHostRows({
      hostsText: "pano-a.example.com\npano-b.example.com",
      hosts: {
        "pano-a.example.com": { enabled: true, until, lastOkAt: "", lastError: "" },
        "pano-b.example.com": { enabled: false, until: "", lastOkAt: "", lastError: "" },
      },
    });
    assert.deepEqual(
      rows.map((row) => [row.host, row.status]),
      [
        ["pano-a.example.com", "Active"],
        ["pano-b.example.com", "Inactive"],
        [SCM_HOST, "Inactive"],
      ],
    );
  });

  it("drops removed hosts when merging", () => {
    const merged = mergeHostMap("keep.example.com", {
      "keep.example.com": { enabled: true, until: "x", lastOkAt: "y", lastError: "" },
      "gone.example.com": { enabled: true, until: "x", lastOkAt: "", lastError: "" },
    });
    assert.deepEqual(Object.keys(merged), ["keep.example.com", SCM_HOST]);
    assert.equal(merged["keep.example.com"].lastOkAt, "y");
  });

  it("defaults and clamps per-host refresh intervals", () => {
    assert.equal(clampIntervalMinutes(10), 10);
    assert.equal(clampIntervalMinutes(7), 5);
    assert.equal(clampIntervalMinutes("nope"), 10);
    const rows = buildHostRows({
      hostsText: "pano-a.example.com",
      hosts: { "pano-a.example.com": { enabled: false, intervalMinutes: 15 } },
    });
    assert.equal(rows[0].intervalMinutes, 15);
    assert.equal(hostFromAlarmName(alarmNameForHost("Pano-A.example.com")), "pano-a.example.com");
  });
});

describe("connecting note", () => {
  it("ticks elapsed seconds while contacting Panorama", () => {
    assert.equal(connectingNote(0), "Contacting Panorama…");
    assert.equal(connectingNote(1), "Contacting Panorama… 1s");
    assert.equal(connectingNote(37), "Contacting Panorama… 37s");
    assert.equal(connectingNote(0, "scm"), "Contacting SCM…");
  });
});

describe("SCM host", () => {
  it("detects the SCM app host and login redirects", () => {
    assert.equal(isScmHost("stratacloudmanager.paloaltonetworks.com"), true);
    assert.equal(isScmHost("panorama.example.com"), false);
    assert.equal(looksLikeScmLoginUrl("https://login.microsoftonline.com/common/oauth2"), true);
    assert.equal(looksLikeScmLoginUrl("https://stratacloudmanager.paloaltonetworks.com/"), false);
    assert.ok(parseHostList("").includes(SCM_HOST));
    assert.equal(parseHostList(SCM_HOST).filter((host) => host === SCM_HOST).length, 1);
  });
});

describe("auto-enable tab match", () => {
  it("matches a configured host from a tab URL", () => {
    assert.equal(hostFromTabUrl("https://pano.example.com/php/"), "pano.example.com");
    assert.equal(
      matchConfiguredHostFromTab("https://pano.example.com/php/", ["pano.example.com", SCM_HOST]),
      "pano.example.com",
    );
  });

  it("skips login pages and unknown hosts", () => {
    assert.equal(
      matchConfiguredHostFromTab("https://pano.example.com/php/login.php", ["pano.example.com"]),
      "",
    );
    assert.equal(
      matchConfiguredHostFromTab("https://other.example.com/", ["pano.example.com"]),
      "",
    );
    assert.equal(
      matchConfiguredHostFromTab(`https://${SCM_HOST}/app`, ["pano.example.com", SCM_HOST]),
      SCM_HOST,
    );
  });
});

describe("PAN firewall recognition", () => {
  it("matches only exact PAN mgmt URLs or ServerToken body", () => {
    assert.equal(isPanOsLoginUrl("https://10.1.2.3/php/login.php"), true);
    assert.equal(isPanOsMgmtUrl("https://10.1.2.3/php/login.php?foo=1"), true);
    assert.equal(isPanOsMgmtUrl("https://10.1.2.3/php/logout.php?vl=2"), true);
    assert.equal(isPanOsMgmtUrl("https://10.1.2.3/php/login.php/"), true);
    assert.equal(isPanOsMgmtUrl("https://10.1.2.3/php/"), false);
    assert.equal(isPanOsMgmtUrl("https://10.1.2.3/login.php"), false);
    assert.equal(isPanOsMgmtUrl("https://example.com/php/login.php.bak"), false);

    assert.equal(looksLikePanOsUi("https://10.1.2.3/", 'window.Pan.st.st.st0 = "abc"'), true);
    assert.equal(looksLikePanOsUi("https://10.1.2.3/php/login.php", "<html></html>"), true);
    assert.equal(looksLikePanOsUi("https://10.1.2.3/php/logout.php?vl=2", "<html></html>"), true);
    assert.equal(looksLikePanOsUi("https://example.com/php/", "<form name='passwd'>Log In</form>"), false);
    assert.equal(looksLikePanOsUi("https://example.com/login.php", "<html>Palo Alto Networks</html>"), false);
    assert.equal(looksLikePanOsUi("https://example.com/", "<html>hello</html>"), false);
  });

  it("keeps ephemeral hosts active until manually turned off", () => {
    assert.equal(
      isHostKeepAliveActive({
        enabled: true,
        untilManual: true,
        until: "",
      }),
      true,
    );
    const rows = buildHostRows({
      hostsText: "",
      hosts: {},
      ephemeralHosts: {
        "10.1.2.3": {
          enabled: true,
          untilManual: true,
          ephemeral: true,
          alias: "PAN firewall",
          intervalMinutes: 10,
          lastOkAt: "",
          lastError: "",
        },
      },
    });
    assert.equal(rows.length, 1 + 1); // SCM preset + ephemeral
    const fw = rows.find((row) => row.host === "10.1.2.3");
    assert.ok(fw);
    assert.equal(fw.enabled, true);
    assert.equal(fw.ephemeral, true);
    assert.equal(fw.kind, "firewall");
    assert.equal(fw.untilManual, true);
  });
});

describe("host aliases", () => {
  it("parses an alias after an IP or FQDN", () => {
    assert.deepEqual(parseHostLine("100.90.211.29 Chicago PA-5220"), {
      host: "100.90.211.29",
      alias: "Chicago PA-5220",
    });
    assert.deepEqual(parseHostLine("Chicago PA-5220 100.90.211.29"), {
      host: "100.90.211.29",
      alias: "Chicago PA-5220",
    });
    assert.deepEqual(parseHostLine("pano.example.com | Skypath"), {
      host: "pano.example.com",
      alias: "Skypath",
    });
    assert.equal(parseHostList("100.90.211.29 Lab FW\npano.example.com")[0], "100.90.211.29");
  });

  it("keeps aliases on rows and round-trips hostsText", () => {
    const hostsText = serializeHostEntries([
      { host: "100.90.211.29", alias: "Lab FW" },
      { host: "pano.example.com", alias: "" },
    ]);
    assert.equal(hostsText, "100.90.211.29 Lab FW\npano.example.com");
    const rows = buildHostRows({
      hostsText,
      hosts: { "100.90.211.29": { enabled: false, alias: "Lab FW" } },
    });
    assert.equal(rows[0].label, "Lab FW");
    assert.equal(rows[0].host, "100.90.211.29");
    assert.equal(hostLabel("100.90.211.29", ""), "100.90.211.29");
    assert.equal(parseHostEntries(hostsText)[0].alias, "Lab FW");
  });
});

describe("disconnect reason", () => {
  it("clears enablement but keeps aliases and intervals after a browser restart", () => {
    const next = deactivateAllHosts({
      "pano-a.example.com": {
        enabled: true,
        until: new Date(Date.now() + 3600_000).toISOString(),
        lastOkAt: new Date().toISOString(),
        lastError: "Failed to fetch",
        intervalMinutes: 15,
        alias: "Lab",
      },
    });
    assert.equal(next["pano-a.example.com"].enabled, false);
    assert.equal(next["pano-a.example.com"].until, "");
    assert.equal(next["pano-a.example.com"].lastOkAt, "");
    assert.equal(next["pano-a.example.com"].lastError, "");
    assert.equal(next["pano-a.example.com"].intervalMinutes, 15);
    assert.equal(next["pano-a.example.com"].alias, "Lab");
  });

  it("shows duration ended after the timer expires", () => {
    const until = new Date(Date.now() - 60 * 1000).toISOString();
    const reason = hostStatusReason({
      enabled: true,
      until,
      lastError: "",
    });
    assert.equal(reason, REASON_DURATION_ENDED);
    const rows = buildHostRows({
      hostsText: "pano-a.example.com",
      hosts: { "pano-a.example.com": { enabled: true, until, lastError: "" } },
    });
    assert.equal(rows[0].status, "Inactive");
    assert.equal(rows[0].lastError, REASON_DURATION_ENDED);
  });

  it("keeps login or fetch failures even after keep-alive stops", () => {
    const until = new Date(Date.now() - 60 * 1000).toISOString();
    assert.equal(
      hostStatusReason({
        enabled: true,
        until,
        lastError: "Failed to fetch",
      }),
      "Failed to fetch",
    );
    assert.equal(
      hostStatusReason({
        enabled: false,
        until: "",
        lastError: REASON_TURNED_OFF,
      }),
      REASON_TURNED_OFF,
    );
  });
});
