/**
 * Preload。运行在 sandbox 里，只能 require("electron")，
 * 所以这里不 require 任何本地模块 —— 频道名用字面量，靠下面的类型断言防漂移。
 */
import { contextBridge, ipcRenderer } from "electron";
import type { IpcRendererEvent } from "electron";

type Channels = typeof import("./lib/types.cjs").IPC;
type PanelState = import("./lib/types.cjs").PanelState;
type SettingsPatch = import("./lib/types.cjs").SettingsPatch;

// 与 src/lib/types.cts 的 IPC 常量必须逐字一致，不一致则编译不过。
const CH: Channels = {
  state: "ua:state",
  getState: "ua:get-state",
  refresh: "ua:refresh",
  openDashboard: "ua:open-dashboard",
  saveSettings: "ua:save-settings",
  clearToken: "ua:clear-token",
  hidePanel: "ua:hide-panel",
  quit: "ua:quit",
};

const api = {
  /** 订阅主进程推送的状态；返回取消订阅函数。 */
  subscribe(cb: (state: PanelState) => void): () => void {
    const handler = (_e: IpcRendererEvent, state: PanelState) => cb(state);
    ipcRenderer.on(CH.state, handler);
    return () => ipcRenderer.removeListener(CH.state, handler);
  },
  getState: (): Promise<PanelState> => ipcRenderer.invoke(CH.getState),
  refresh: (): Promise<PanelState> => ipcRenderer.invoke(CH.refresh),
  openDashboard: (): void => ipcRenderer.send(CH.openDashboard),
  /** token 字段留空表示「不改动」，传空串表示清除。 */
  saveSettings: (patch: SettingsPatch): Promise<PanelState> => ipcRenderer.invoke(CH.saveSettings, patch),
  clearToken: (): Promise<PanelState> => ipcRenderer.invoke(CH.clearToken),
  hide: (): void => ipcRenderer.send(CH.hidePanel),
  quit: (): void => ipcRenderer.send(CH.quit),
};

contextBridge.exposeInMainWorld("ua", api);

export type UaBridge = typeof api;
