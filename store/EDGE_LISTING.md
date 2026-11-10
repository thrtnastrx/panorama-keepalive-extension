# Edge Add-ons listing — Panorama Keep-Alive

Privacy policy URL: https://gist.github.com/thrtnastrx/54392be913cc6dccd6cc26578c92461f

Package: `aa-lab/edge-store-packages/panorama-keepalive-0.1.13.zip`

Use Hidden / Unlisted availability.

## Name
Panorama Keep-Alive

## Short description
Quietly refresh your Panorama web login to avoid idle-timer logouts

## Description
Panorama Keep-Alive keeps an existing Palo Alto Panorama or Strata Cloud Manager web login from idle-timeout logout.

How it works:

- Log into Panorama or SCM in Microsoft Edge first.
- Add Panorama hosts in Options, or enable the built-in SCM row in the popup.
- Choose a duration and refresh interval.
- The extension uses cookies already in this browser. It does not store a password.

Panorama hosts are refreshed with a background request to the web UI. SCM uses an open SCM tab (or opens one in the background) and sends activity in that page.

This does not override Max Session Time or MFA lifetime. Closing Edge stops keep-alive.

## Category
Productivity

## Single purpose
Refresh existing Panorama and Strata Cloud Manager web logins so idle timers do not sign the user out.

## Permission justifications
- alarms: schedule keep-alive refreshes
- storage: save hosts, aliases, duration, and interval
- tabs: find or open an SCM tab without taking focus
- scripting: send activity in the SCM page
- optional host access (https://*/*): only the Panorama or SCM hosts the user enables

## Remote code
No

## Data use
No account data collected. Settings stay on the device. Requests go only to hosts the user enables.

## Reviewer notes
1. Load the extension and open Options.
2. SCM is already listed in the popup. For Panorama, add a lab FQDN you can log into.
3. Allow host permission when prompted.
4. Check a host in the popup. Confirm Connecting then Active, or a clear error if you are not logged in.
5. SCM may open a background tab on stratacloudmanager.paloaltonetworks.com.

No publisher login is required. Reviewers can use any test Panorama they already have, or leave Panorama hosts empty and inspect the SCM row only.
