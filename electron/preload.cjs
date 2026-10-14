// The only native capabilities exposed to the page.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("docai", {
  pickFolder: (defaultPath) => ipcRenderer.invoke("docai:pick-folder", defaultPath),
  piEnabledModels: () => ipcRenderer.invoke("docai:pi-enabled-models"),
  readClipboardImage: () => ipcRenderer.invoke("docai:read-clipboard-image"),
});
