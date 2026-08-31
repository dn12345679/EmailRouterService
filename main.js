import { app, BrowserWindow } from "electron";
import path from "path";

let mainWindow;

async function createWindow() {
    if (app.isPackaged) {
        // Secrets and business config must never ship inside the (trivially-extractable) asar
        // bundle -- point them at files dropped next to the installed executable instead, so
        // they're supplied post-install rather than baked into the distributed app. This has to
        // happen BEFORE server.js (and its transitive appsettings.js import) is ever loaded,
        // since that's where these env vars are read, at module-evaluation time -- hence the
        // dynamic import below instead of a static one at the top of this file.
        const installDir = path.dirname(app.getPath('exe'));
        process.env.ENV_FILE_PATH = path.join(installDir, '.env');
        process.env.CONFIG_FILE_PATH = path.join(installDir, 'config.js');
        // Public data, not a secret -- fine to ship a default inside the asar, but still
        // overridable post-install without a rebuild if you want to update it yourself.
        process.env.PROPERTY_REGION_FILE_PATH = path.join(installDir, 'propertyToRegion.json');
    }

    const { startServer } = await import("./server.js");
    await startServer();

    mainWindow = new BrowserWindow({
        width: 1200,
        height: 800,
        title: "Email Router",
        webPreferences: {
            contextIsolation: true,
            nodeIntegration: false
        }
    });

    await mainWindow.loadURL("http://localhost:3000");
}

app.whenReady().then(createWindow);

app.on("window-all-closed", () => {
    app.quit();
});