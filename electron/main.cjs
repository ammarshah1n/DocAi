const { app, BrowserWindow, clipboard, dialog, ipcMain, session, shell } = require("electron");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const DEV_URL = process.env.DOCAI_DEV_URL;
// One-shot snapshot from a real native paste shortcut, never an unrestricted clipboard reader.
const pasteImages = new WeakMap();

// Agent-produced links must not launch file:// or arbitrary OS protocol handlers.
function openWebLink(value) {
  let url;
  try { url = new URL(value); } catch { return; }
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) return;
  shell.openExternal(url.href).catch(() => dialog.showErrorBox("DocAi", "Could not open that web link."));
}

function createWindow() {
  const win = new BrowserWindow({
    show: false,
    paintWhenInitiallyHidden: true,
    width: 1440,
    height: 900,
    minWidth: 720,
    minHeight: 480,
    backgroundColor: "#f9fbfd",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 14, y: 14 },
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: true, preload: path.join(__dirname, "preload.cjs") },
  });
  win.webContents.on("before-input-event", (_event, input) => {
    if (input.type !== "keyDown" || input.key.toLowerCase() !== "v" || !(input.meta || input.control)) return;
    const snapshot = { image: clipboard.readImage(), expires: Date.now() + 1500 };
    pasteImages.set(win.webContents, snapshot);
    setTimeout(() => { if (pasteImages.get(win.webContents) === snapshot) pasteImages.delete(win.webContents); }, 1500).unref();
  });
  // Keep untrusted destinations outside the privileged app renderer.
  win.webContents.setWindowOpenHandler(({ url }) => (openWebLink(url), { action: "deny" }));
  win.webContents.on("will-navigate", (e, url) => {
    try {
      const target = new URL(url);
      if (DEV_URL && target.origin === new URL(DEV_URL).origin && !target.username && !target.password) return;
    } catch { /* Invalid destinations are blocked below. */ }
    e.preventDefault();
    openWebLink(url);
  });
  // Never-break: a crashed or hung renderer reloads itself.
  win.webContents.on("render-process-gone", () => setTimeout(() => !win.isDestroyed() && win.reload(), 500));
  win.on("unresponsive", () => !win.isDestroyed() && win.reload());
  // Review mode never shows the window: tests drive it over CDP, nothing appears on screen.
  win.once("ready-to-show", () => !REVIEW && win.show());
  if (process.env.DOCAI_DEBUG) win.webContents.on("console-message", (e) => console.log("[renderer]", e.level, e.message));
  // DOCAI_LAYOUT='{"panes":[...]}' seeds the workspace on launch (review/screenshot runs).
  let seeded = !process.env.DOCAI_LAYOUT;
  const onLoad = () => {
    if (!seeded) {
      seeded = true;
      return win.webContents.executeJavaScript(`localStorage.setItem("docai.layout.v1", ${JSON.stringify(process.env.DOCAI_LAYOUT)})`).then(() => win.webContents.reload());
    }
    win.webContents.off("did-finish-load", onLoad);
    // Review hook: DOCAI_SHOT=/path.png [DOCAI_SHOT_DELAY=ms] captures the window then quits.
    if (process.env.DOCAI_SHOT)
      setTimeout(async () => {
        const img = await win.webContents.capturePage();
        require("node:fs").writeFileSync(process.env.DOCAI_SHOT, img.toPNG());
        app.quit();
      }, Number(process.env.DOCAI_SHOT_DELAY ?? 4000));
  };
  win.webContents.on("did-finish-load", onLoad);
  if (DEV_URL) win.loadURL(DEV_URL);
  else win.loadFile(path.join(__dirname, "..", "dist", "index.html"));
}

// Review mode (DOCAI_REVIEW / DOCAI_SHOT): run as a background accessory app that never takes focus,
// so automated screenshots and cua-driver sessions don't interrupt the user.
const REVIEW = !!(process.env.DOCAI_REVIEW || process.env.DOCAI_SHOT);
// DOCAI_PROFILE=<dir> isolates storage so a review instance can run beside the user's own window.
if (process.env.DOCAI_PROFILE) app.setPath("userData", process.env.DOCAI_PROFILE);
if (REVIEW && process.platform === "darwin") app.setActivationPolicy("accessory");

ipcMain.handle("docai:pick-folder", async (e, defaultPath) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const r = await dialog.showOpenDialog(win, { properties: ["openDirectory", "createDirectory"], defaultPath: defaultPath || os.homedir() });
  return r.canceled ? null : r.filePaths[0];
});
// Consume only the image captured by that physical paste, not a later clipboard value.
ipcMain.handle("docai:read-clipboard-image", (event) => {
  const snapshot = pasteImages.get(event.sender);
  pasteImages.delete(event.sender);
  if (!snapshot || snapshot.expires < Date.now()) return null;
  const image = snapshot.image;
  if (image.isEmpty()) return null;
  const { width, height } = image.getSize();
  if (width * height > 40_000_000) throw new Error("Clipboard image is too large. Resize it before pasting.");
  const png = image.toPNG();
  if (png.length > 20 * 1024 * 1024) throw new Error("Images must be smaller than 20 MB.");
  return { mimeType: "image/png", data: png.toString("base64") };
});
// pi's scoped model list (settings.json "enabledModels"); null when pi has no scope configured.
ipcMain.handle("docai:pi-enabled-models", () => {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".pi", "agent", "settings.json"), "utf8"));
    return Array.isArray(s.enabledModels) ? s.enabledModels.filter((m) => typeof m === "string") : null;
  } catch {
    return null;
  }
});

app.whenReady().then(() => {
  // The Paseo daemon rejects browser Origins on its local WebSocket; strip it for loopback only.
  session.defaultSession.webRequest.onBeforeSendHeaders(
    { urls: ["ws://127.0.0.1:6767/*", "http://127.0.0.1:6767/*"] },
    (details, cb) => {
      delete details.requestHeaders.Origin;
      delete details.requestHeaders.origin;
      cb({ requestHeaders: details.requestHeaders });
    },
  );
  // DocAi needs no browser permissions (camera, mic, location, …); deny them all.
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, cb) => cb(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  createWindow();
  app.on("activate", () => BrowserWindow.getAllWindows().length === 0 && createWindow());
});
app.on("window-all-closed", () => process.platform !== "darwin" && app.quit());
