# Experimental stealth-signal comparison (A-140 follow-up)

This is an opt-in experiment, not a supported bridge setting. With
`CHATGPT_BRIDGE_EXPERIMENTAL_STEALTH` unset or set to `0`, every existing launch remains on the
normal no-stealth path.

The experiment changes only the observed value of `navigator.webdriver`, which was measured as
`true` on the daemon page that motivated A-140. It intentionally does not invent `cdc_` globals:
none were found in that measurement. It also does not fabricate `window.chrome.runtime`; Chrome's
runtime API belongs to extension contexts, so its absence on an ordinary page with no extensions
is not enough to justify changing it.

The single patch source is `src/browser/stealth-signals.ts`. `npm run build` writes its generated
counterpart to `experimental/stealth-extension/content.js`; do not edit that generated file. The
extension is committed as a small inspectable Manifest V3 artifact rather than generated under
`runtime/`, because a human must be able to inspect exactly what is loaded. Its content script runs
at `document_start` in the page's `MAIN` execution world, not the default isolated world; otherwise
the page itself would not observe the patched property.

Select exactly one mode before starting a fresh browser or daemon:

```powershell
# Baseline (default): no patch
Remove-Item Env:CHATGPT_BRIDGE_EXPERIMENTAL_STEALTH -ErrorAction Ignore

# CDP-side Playwright context init script (`1` is a supported concise alias)
$env:CHATGPT_BRIDGE_EXPERIMENTAL_STEALTH = "initscript"

# Local unpacked Chrome extension content script
$env:CHATGPT_BRIDGE_EXPERIMENTAL_STEALTH = "extension"
```

For a daemon, the mode is fixed at `daemon start`; stop and start it when changing modes. Clients
refuse to attach to a daemon started in a different experimental mode, preventing an accidental
mixed comparison. The extension has no permissions and no bridge logic.

## Chrome-channel limitation found during setup

The automatic extension path is not available on the installed `channel: "chrome"` browser. A
fresh temporary persistent Chrome 152.0.0.0 profile was launched with both
`--disable-extensions-except=<extension-dir>` and `--load-extension=<extension-dir>`. Its
`chrome://extensions` item list was empty, and a locally intercepted `https://chatgpt.com/` page
still reported `navigator.webdriver=true`. This was not a network or account test; interception
avoided making a live request after the environment blocked direct browser network access.

Chrome 137+ is known to ignore those unpacked-extension launch switches, so the bridge now refuses
`CHATGPT_BRIDGE_EXPERIMENTAL_STEALTH=extension` with its default `channel=chrome`, rather than
misleadingly run an unpatched comparison. The launch flags remain available for
`CHATGPT_BRIDGE_CHANNEL=chromium`, where they are the conventional persistent-context mechanism,
but this workspace has no Playwright Chromium executable installed; that branch is not verified
here. Do not treat the extension mechanism as available until it is re-tested with a suitable
browser binary or an approved manual extension-install workflow.

Run the diagnostic for the baseline and init-script modes (with a deliberately selected profile)
to print the observed fingerprint without sending a prompt:

```powershell
npm.cmd run build
node dist/cli/main.js stealth-signals
```

`stealth-signals` navigates to `https://chatgpt.com/` and reports the selected mode plus
`navigator.webdriver`. It is only a setup check: it cannot establish whether the init-script
mechanism reduces re-challenges, which requires the separately approved, real-session observation
over time.
