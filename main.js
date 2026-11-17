import { app, BrowserWindow } from "electron";
import path from "path";

let mainWindow;

async function createWindow() {
    if (app.isPackaged) {


        // post install supplied files will be used over the baked in distributed app, this runs before .env imports
        const installDir = path.dirname(app.getPath('exe'));
        process.env.ENV_FILE_PATH = path.join(installDir, '.env');
        process.env.CONFIG_FILE_PATH = path.join(installDir, 'config.js');
        
        // default uses the properties of h&s, since this is all public info
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