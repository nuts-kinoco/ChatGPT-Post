# Bridge Control GUI

This independent Electron package is the tray-resident shell for the Bridge Control monitor.
It currently renders only a static L1 Bar placeholder; it has no IPC, CLI polling, or runtime access.

## Development

```powershell
cd gui
npm install
npm run dev
```

Right-click the tray icon and choose **Show**, or click the icon, to open the 380×40 L1 Bar.
Choose **Quit** from the tray menu to exit. `npm run build`, `npm run typecheck`, and `npm run lint`
operate only on this package.
