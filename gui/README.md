# Bridge Control GUI

The Electron package now starts as a compact resident bar (up to 440×46),
with explicit downward expansion in the same window to a total 440×604 panel. Every page uses the same frame and scrolls internally; drafts and selected jobs survive collapse. It loads the same authenticated loopback service used by `chatgpt-bridge ui`.
This is a wired application entrypoint, not the standalone design mock.

## Build and launch

From the repository root:

```powershell
npm ci
npm run build
$env:CHATGPT_BRIDGE_ROOT = (Get-Location).Path
$env:CHATGPT_BRIDGE_RUNTIME_DIR = Join-Path $env:LOCALAPPDATA 'ChatGPTBridge\runtime'
cd gui
npm ci
npm start
```

Default profile is `production`; unconfigured executor/approval actions are disabled with reasons.
To exercise persistent synthetic lifecycle flows without models/processes/network, explicitly set
`$env:CHATGPT_BRIDGE_UI_PROFILE = 'demo'` before starting. Demo uses `runtime/ui-demo/jobs.db`;
production uses `runtime/jobs.db`. Never treat synthetic results as real execution evidence.

Tray click restores the prior visible mode; Ctrl+Shift+C toggles hide/restore. The tray includes v2 details, the existing browser-chat
UI, and Quit. Legacy `run/submit/status/wait/result` routes remain available. The old GUI's doctor
polling starts only when the user opens that legacy view.

The v2 renderer uses a sandbox without the legacy privileged preload. Its private per-launch
capability URL is not a share link and must not appear in logs, messages or screenshots.

## Packaged Windows build

```powershell
npm run package
```

The portable executable is written to `gui/release/`. Rebuild after updating source; an old exe
will not update itself. Set `CHATGPT_BRIDGE_ROOT` to the updated, built repository before launch.
Each launch uses its own extraction directory (`portable.unpackDirName: true`) to avoid removing
files used by an existing instance.

## Checks and handoff

`npm run build`, `npm run typecheck`, `npm run lint`, and `npm test` verify this package.
Cloud checks do not establish Windows rendering, process-tree/NTFS behavior, or production model execution.

- [Resident display/theme guide](../docs/bridge-v2/UI-PRESENTATION.md)
- [Usage guide](../docs/bridge-v2/UI-USAGE.md)
- [Test procedure](../docs/bridge-v2/UI-TESTING.md)

Legacy request metadata remains optional and display-only: `runtime/requests/<requestId>/meta.json`
may contain `caller`, `project`, and `title`. Missing values retain the existing fallbacks.
