import { app, BrowserWindow } from "electron";
import { startServer } from "./server.js";

let mainWindow;

async function createWindow() {
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