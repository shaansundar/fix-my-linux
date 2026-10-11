import { contextBridge } from "electron";

contextBridge.exposeInMainWorld("fml", {
  platform: process.platform,
});
