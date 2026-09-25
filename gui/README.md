# Bridge Control GUI

This independent Electron package is the tray-resident, read-only Bridge Control monitor. It polls
`node ../dist/cli/main.js doctor --json` and scans `../runtime/requests/`; it never invokes a
mutating CLI command or writes under `runtime/`.

## Optional request display metadata

Callers may add `runtime/requests/<requestId>/meta.json` beside `request.json` for GUI display
only. It is not part of the bridge request contract and the bridge neither reads nor writes it:

```json
{ "caller": "Codex", "project": "Bridge", "title": "Short display title" }
```

All fields are optional. Missing `caller` and `project` render as `—`; a missing `title` falls
back to the first non-empty `prompt.md` line, then the request ID.

## Development

```powershell
cd gui
npm install
npm run dev
```

Right-click the tray icon and choose **Show**, or click the icon, to open the 380×40 L1 Bar.
Click the Bar to expand/collapse its 380×520 read-only L2 Popup. Choose **Quit** from the tray
menu to exit. `npm run build`, `npm run typecheck`, and `npm run lint` operate only on this package.
