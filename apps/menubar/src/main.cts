/**
 * UsageAccumulator 菜单栏常驻 app —— 主进程。
 *
 * 这个 app 只做一件事：不点开任何东西就能看到额度还剩多少、什么时候耗尽。
 * 统计、图表、分布一律走网页看板（面板底部「打开看板」）。
 */
import {
  app,
  BrowserWindow,
  Menu,
  Tray,
  ipcMain,
  nativeImage,
  nativeTheme,
  powerMonitor,
  screen,
  shell,
} from "electron";
import type { IpcMainEvent, IpcMainInvokeEvent, Rectangle } from "electron";
import * as path from "node:path";

import { ConfigStore, POLL_MAX_SECONDS, POLL_MIN_SECONDS } from "./lib/config.cjs";
import { fetchSummary, SummaryError } from "./lib/summary-client.cjs";
import { composeTray, TRAY_TICK_MS } from "./lib/tray-title.cjs";
import { log, errText } from "./lib/log.cjs";
import { IPC, isAuthCode } from "./lib/types.cjs";
import type { PanelState, PanelStatus, SettingsPatch, Summary, UaErrorCode } from "./lib/types.cjs";

const PANEL_WIDTH = 300;
const PANEL_HEIGHT = 360;
/** 托盘与面板之间的缝隙 */
const PANEL_GAP = 6;

let tray: Tray | null = null;
let panel: BrowserWindow | null = null;
let config: ConfigStore;

// ---- 运行时状态 ------------------------------------------------------------
let summary: Summary | null = null;
/** 最后一次失败的简短原因（已脱敏）与错误码；成功后清空 */
let lastError: string | null = null;
let lastErrorCode: UaErrorCode | null = null;
let pollTimer: NodeJS.Timeout | null = null;
/** 托盘标题的自刷新心跳，与轮询完全独立，不发任何请求 */
let trayTicker: NodeJS.Timeout | null = null;
let inflight: AbortController | null = null;
/** 面板最后一次隐藏的时刻，用来吃掉「blur 关闭 + click 重开」的抖动 */
let lastHideAt = 0;

function currentStatus(): PanelStatus {
  if (!config.get().serverUrl) return "unconfigured";
  // 凭证失效自成一态：重试没用，要提示用户去改 token
  if (isAuthCode(lastErrorCode)) return "auth";
  if (lastError !== null) return "offline";
  if (!summary) return "loading";
  return summary.stale ? "stale" : "ok";
}

/** 额度快照的年龄 —— 由 captured_at 算，衡量的是额度新鲜度而非网络新鲜度。 */
function snapshotAgeSeconds(): number | null {
  const at = summary?.captured_at;
  if (!at) return null;
  const ms = Date.parse(at);
  if (Number.isNaN(ms)) return null;
  return Math.max(0, Math.round((Date.now() - ms) / 1000));
}

/** 服务端回显的 profile 与本地配置对不上 —— 说明看到的数字属于别的 profile。 */
function profileMismatch(): boolean {
  const echoed = summary?.profile_id;
  if (!echoed) return false;
  const wanted = config.get().profileId;
  return wanted !== "" && echoed !== wanted;
}

function buildState(): PanelState {
  const view = config.view();
  return {
    status: currentStatus(),
    summary,
    snapshotAgeSeconds: snapshotAgeSeconds(),
    profileMismatch: profileMismatch(),
    error: lastError,
    errorCode: lastErrorCode,
    theme: nativeTheme.shouldUseDarkColors ? "dark" : "light",
    settings: {
      ...view,
      // 系统才是开机自启的真相源，配置只是我们的意图
      launchAtLogin: app.getLoginItemSettings().openAtLogin,
    },
  };
}

// ---- 托盘 ------------------------------------------------------------------

function render(): void {
  const state = buildState();
  if (tray) {
    const view = composeTray(state);
    // monospacedDigit：刷新时数字不跳动（ARCHITECTURE.md §8 美学基线）
    tray.setTitle(view.title, { fontType: "monospacedDigit" });
    tray.setToolTip(`UsageAccumulator · ${view.tooltip}`);
  }
  if (panel && !panel.isDestroyed()) {
    panel.webContents.send(IPC.state, state);
  }
}

// ---- 轮询 ------------------------------------------------------------------

function schedule(): void {
  if (pollTimer) clearTimeout(pollTimer);
  const seconds = Math.min(POLL_MAX_SECONDS, Math.max(POLL_MIN_SECONDS, config.get().pollSeconds));
  pollTimer = setTimeout(() => void poll(), seconds * 1000);
}

async function poll(): Promise<void> {
  const cfg = config.get();
  if (!cfg.serverUrl) {
    render();
    schedule();
    return;
  }

  inflight?.abort();
  const ac = new AbortController();
  inflight = ac;

  try {
    const next = await fetchSummary({
      serverUrl: cfg.serverUrl,
      token: cfg.token,
      profileId: cfg.profileId,
      signal: ac.signal,
    });
    // 已被更新的一次请求取代：丢弃结果，由那一次负责渲染与排期
    if (inflight !== ac) return;
    summary = next;
    lastError = null;
    lastErrorCode = null;
  } catch (err) {
    if (inflight !== ac) return;
    // 失败 = 优雅降级；保留上一次数据，由 composeTray 按快照年龄决定还能不能显示
    if (err instanceof SummaryError) {
      lastError = err.message;
      lastErrorCode = err.code;
    } else {
      lastError = errText(err);
      lastErrorCode = "unknown";
    }
    log.warn(`summary fetch failed [${lastErrorCode}]: ${lastError}`);
  } finally {
    if (inflight === ac) inflight = null;
  }

  render();
  schedule();
}

function refreshNow(): void {
  if (pollTimer) clearTimeout(pollTimer);
  void poll();
}

// ---- 面板窗口 --------------------------------------------------------------

function createPanel(): BrowserWindow {
  const win = new BrowserWindow({
    width: PANEL_WIDTH,
    height: PANEL_HEIGHT,
    show: false,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    transparent: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#141413" : "#FAF9F5",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
      devTools: !app.isPackaged,
    },
  });

  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  void win.loadFile(path.join(__dirname, "renderer", "index.html"));

  // 面板里不允许任何导航或开新窗口
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (e) => e.preventDefault());

  win.on("blur", () => {
    if (win.isDestroyed()) return;
    lastHideAt = Date.now();
    win.hide();
  });
  win.on("closed", () => {
    panel = null;
  });
  return win;
}

function positionPanel(win: BrowserWindow, trayBounds?: Rectangle): void {
  const anchor = trayBounds ?? tray?.getBounds();
  const point = anchor
    ? { x: Math.round(anchor.x + anchor.width / 2), y: Math.round(anchor.y + anchor.height) }
    : screen.getCursorScreenPoint();
  const work = screen.getDisplayNearestPoint(point).workArea;

  let x = Math.round(point.x - PANEL_WIDTH / 2);
  x = Math.min(Math.max(x, work.x + 8), work.x + work.width - PANEL_WIDTH - 8);
  const y = Math.max(point.y + PANEL_GAP, work.y);
  win.setPosition(x, y, false);
}

function showPanel(trayBounds?: Rectangle): void {
  if (!panel || panel.isDestroyed()) panel = createPanel();
  positionPanel(panel, trayBounds);
  panel.show();
  panel.focus();
  render();
}

function togglePanel(trayBounds?: Rectangle): void {
  if (panel && !panel.isDestroyed() && panel.isVisible()) {
    hidePanel();
    return;
  }
  // 点托盘会先触发面板 blur（已经隐藏），紧接着这次 click 又会把它开回来。
  // 这个窗口期内的点击当作「关闭」处理。
  if (Date.now() - lastHideAt < 250) return;
  showPanel(trayBounds);
}

function hidePanel(): void {
  if (panel && !panel.isDestroyed()) {
    lastHideAt = Date.now();
    panel.hide();
  }
}

// ---- 动作 ------------------------------------------------------------------

function openDashboard(): void {
  const candidate = summary?.dashboard_url || config.get().serverUrl;
  if (!candidate) return;
  try {
    const u = new URL(candidate);
    // dashboard_url 来自服务端响应（外部数据），协议必须先验再交给系统浏览器
    if (u.protocol !== "http:" && u.protocol !== "https:") {
      log.warn(`dashboard_url rejected: unsupported protocol ${u.protocol}`);
      return;
    }
    void shell.openExternal(u.toString());
    hidePanel();
  } catch {
    log.warn("dashboard_url rejected: not a valid URL");
  }
}

function applyLoginItem(openAtLogin: boolean): void {
  app.setLoginItemSettings({ openAtLogin, openAsHidden: true });
}

function sanitizePatch(raw: unknown): SettingsPatch {
  if (typeof raw !== "object" || raw === null) return {};
  const r = raw as Record<string, unknown>;
  const out: SettingsPatch = {};
  if (typeof r["serverUrl"] === "string") out.serverUrl = r["serverUrl"].slice(0, 2048);
  if (typeof r["profileId"] === "string") out.profileId = r["profileId"].slice(0, 256);
  if (typeof r["pollSeconds"] === "number") out.pollSeconds = r["pollSeconds"];
  if (typeof r["launchAtLogin"] === "boolean") out.launchAtLogin = r["launchAtLogin"];
  if (typeof r["token"] === "string") out.token = r["token"].slice(0, 4096);
  return out;
}

// ---- 托盘菜单 --------------------------------------------------------------

function buildTrayMenu(): Menu {
  return Menu.buildFromTemplate([
    { label: "打开看板", click: openDashboard },
    { label: "刷新", click: refreshNow },
    { type: "separator" },
    {
      label: "开机自启",
      type: "checkbox",
      checked: app.getLoginItemSettings().openAtLogin,
      click: (item) => {
        applyLoginItem(item.checked);
        config.patch({ launchAtLogin: item.checked });
        render();
      },
    },
    { type: "separator" },
    { label: "退出", click: () => app.quit() },
  ]);
}

// ---- IPC -------------------------------------------------------------------

function fromPanel(event: IpcMainEvent | IpcMainInvokeEvent): boolean {
  return panel !== null && !panel.isDestroyed() && event.sender === panel.webContents;
}

function registerIpc(): void {
  ipcMain.handle(IPC.getState, (e) => (fromPanel(e) ? buildState() : null));

  ipcMain.handle(IPC.refresh, async (e) => {
    if (!fromPanel(e)) return null;
    if (pollTimer) clearTimeout(pollTimer);
    await poll();
    return buildState();
  });

  ipcMain.handle(IPC.saveSettings, async (e, raw: unknown) => {
    if (!fromPanel(e)) return null;
    const patch = sanitizePatch(raw);
    const changed = config.patch(patch);
    if (patch.launchAtLogin !== undefined) applyLoginItem(patch.launchAtLogin);
    if (changed) {
      // 配置一变就立刻重试，不要让用户等一个轮询周期
      lastError = null;
      lastErrorCode = null;
      if (pollTimer) clearTimeout(pollTimer);
      await poll();
    }
    return buildState();
  });

  ipcMain.handle(IPC.clearToken, async (e) => {
    if (!fromPanel(e)) return null;
    config.patch({ token: "" });
    if (pollTimer) clearTimeout(pollTimer);
    await poll();
    return buildState();
  });

  ipcMain.on(IPC.openDashboard, (e) => {
    if (fromPanel(e)) openDashboard();
  });
  ipcMain.on(IPC.hidePanel, (e) => {
    if (fromPanel(e)) hidePanel();
  });
  ipcMain.on(IPC.quit, (e) => {
    if (fromPanel(e)) app.quit();
  });
}

// ---- 启动 ------------------------------------------------------------------

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => showPanel());

  void app.whenReady().then(() => {
    // 纯菜单栏 app：不占 Dock，不开窗口
    app.dock?.hide();

    config = new ConfigStore(app.getPath("userData"));
    applyLoginItem(config.get().launchAtLogin);

    // 托盘只靠标题说话（标题里已经含状态字形），不用图标资源
    tray = new Tray(nativeImage.createEmpty());
    tray.setIgnoreDoubleClickEvents(true);
    tray.on("click", (_e, bounds) => togglePanel(bounds));
    tray.on("right-click", () => tray?.popUpContextMenu(buildTrayMenu()));

    registerIpc();
    panel = createPanel();

    nativeTheme.on("updated", () => {
      if (panel && !panel.isDestroyed()) {
        panel.setBackgroundColor(nativeTheme.shouldUseDarkColors ? "#141413" : "#FAF9F5");
      }
      render();
    });
    // 休眠唤醒后数据必然过期，立刻补一次
    powerMonitor.on("resume", () => refreshNow());

    // 倒计时是本地算的（契约 §2.2），所以标题要独立于轮询自己走表。
    // 这条心跳不发任何请求，只把 exhaust_eta 重新折算成 "1:48"。
    trayTicker = setInterval(render, TRAY_TICK_MS);

    render();
    void poll();
    log.info("ready");
  });

  // 菜单栏 app：关掉面板不等于退出
  app.on("window-all-closed", () => {
    /* keep running */
  });
  app.on("before-quit", () => {
    if (pollTimer) clearTimeout(pollTimer);
    if (trayTicker) clearInterval(trayTicker);
    inflight?.abort();
  });
}
