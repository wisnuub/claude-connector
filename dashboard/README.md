# Site Maintenance

The add-on dashboard for [Claude Connector](https://github.com/wisnuub/claude-connector): keep many WordPress sites updated, tested and secure from one page on your own computer. Every site needs the Claude Connector plugin, 1.8.0 or newer.

Needs Node.js 18+ and Google Chrome or Microsoft Edge.

## Start it

From the downloaded `site-maintenance.zip` (dependencies included):

```bash
cd site-maintenance/dashboard
npm start            # → http://127.0.0.1:4590
```

From a clone of the repository, run `npm install` in this folder first.

- **macOS:** run `npm run shortcut` once. It creates **Site Maintenance.app**; after that, open it like any other app.
- **Browser extension:** in Chrome or Edge, open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked** and choose the `extension` folder. Its toolbar icon opens the dashboard - and on a Mac starts it first when it is not running, once `npm run shortcut` has been run.

Full guide: [Maintenance dashboard](https://github.com/wisnuub/claude-connector#maintenance-dashboard-many-sites).
