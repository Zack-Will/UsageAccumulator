/* 面板渲染层。朴素 DOM，无框架 —— 这块 UI 太小，不值得上 React。
   只通过 preload 暴露的 window.ua 与主进程通信；不发任何网络请求。
   倒计时一律本地从 exhaust_eta 算（契约 §2.2），陈旧时长一律从 captured_at 算。 */
(function () {
  "use strict";

  /** @type {import("../preload.cjs").UaBridge} */
  var ua = window.ua;

  var el = {
    root: document.documentElement,
    main: document.getElementById("main"),
    banner: document.getElementById("banner"),
    eta: document.getElementById("eta"),
    etaLabel: document.getElementById("etaLabel"),
    rate: document.getElementById("rate"),
    rows: document.getElementById("rows"),
    dash: document.getElementById("dash"),
    quit: document.getElementById("quit"),
    openSettings: document.getElementById("openSettings"),
    closeSettings: document.getElementById("closeSettings"),
    settings: document.getElementById("settings"),
    serverUrl: document.getElementById("serverUrl"),
    token: document.getElementById("token"),
    profileId: document.getElementById("profileId"),
    pollSeconds: document.getElementById("pollSeconds"),
    launchAtLogin: document.getElementById("launchAtLogin"),
    save: document.getElementById("save"),
    clearToken: document.getElementById("clearToken"),
  };

  var STALE_MS = 15 * 60 * 1000;
  var state = null;
  var lastRefreshAt = 0;

  // ---- 格式化 -------------------------------------------------------------

  function clampPct(v) {
    if (typeof v !== "number" || !isFinite(v)) return 0;
    return Math.min(100, Math.max(0, v));
  }

  /** ms → "1:48"；≥24h → "2d3h" */
  function countdown(ms) {
    if (!isFinite(ms) || ms <= 0) return "0:00";
    var totalMin = Math.floor(ms / 60000);
    if (totalMin >= 1440) {
      var d = Math.floor(totalMin / 1440);
      var dh = Math.floor((totalMin % 1440) / 60);
      return dh > 0 ? d + "d" + dh + "h" : d + "d";
    }
    var h = Math.floor(totalMin / 60);
    var m = totalMin % 60;
    return h + ":" + (m < 10 ? "0" : "") + m;
  }

  /** RFC3339 → 距今的倒计时；解析不了返回 null */
  function etaCountdown(iso) {
    if (!iso) return null;
    var ms = new Date(iso).getTime();
    if (isNaN(ms)) return null;
    return countdown(ms - Date.now());
  }

  function pad2(n) {
    return (n < 10 ? "0" : "") + n;
  }

  /** RFC3339 → 本地 "10:30"（今天）或 "9/24 01:00" */
  function resetAt(iso) {
    if (!iso) return "—";
    var t = new Date(iso);
    if (isNaN(t.getTime())) return "—";
    var now = new Date();
    var hm = pad2(t.getHours()) + ":" + pad2(t.getMinutes());
    var sameDay =
      t.getFullYear() === now.getFullYear() && t.getMonth() === now.getMonth() && t.getDate() === now.getDate();
    return sameDay ? hm : t.getMonth() + 1 + "/" + t.getDate() + " " + hm;
  }

  /** 额度快照的年龄文案。参数来自 captured_at，不是本次请求时刻。 */
  function ageText(seconds) {
    if (seconds === null || seconds === undefined) return "无数据";
    if (seconds < 90) return "刚刚";
    var min = Math.round(seconds / 60);
    if (min < 60) return min + " 分钟前";
    return Math.round(min / 60) + " 小时前";
  }

  function severity(pct, projected) {
    var p = Math.max(pct || 0, projected || 0);
    if (p >= 100) return "danger";
    if (p >= 80) return "warn";
    return "ok";
  }

  function tone(pct, projected) {
    return "var(--" + severity(pct, projected) + ")";
  }

  /** 整体严重度 = 最吃紧的那个窗口，顶部读数与进度条共用这一套语义 */
  function worstSeverity(windows) {
    var worst = "ok";
    for (var i = 0; i < (windows || []).length; i++) {
      var s = severity(windows[i].pct, windows[i].projected_pct);
      if (s === "danger") return "danger";
      if (s === "warn") worst = "warn";
    }
    return worst;
  }

  // ---- 行 -----------------------------------------------------------------

  function makeRow() {
    var li = document.createElement("li");
    li.className = "row";

    var top = document.createElement("div");
    top.className = "row-top";
    var label = document.createElement("span");
    label.className = "row-label";
    var pct = document.createElement("span");
    pct.className = "row-pct num";
    var pctNum = document.createElement("span");
    var unit = document.createElement("span");
    unit.className = "unit";
    unit.textContent = "%";
    pct.appendChild(pctNum);
    pct.appendChild(unit);
    top.appendChild(label);
    top.appendChild(pct);

    var bar = document.createElement("div");
    bar.className = "bar";
    var proj = document.createElement("span");
    proj.className = "bar-proj";
    var used = document.createElement("span");
    used.className = "bar-used";
    bar.appendChild(proj);
    bar.appendChild(used);

    var foot = document.createElement("div");
    foot.className = "row-foot num";
    var exhaust = document.createElement("span");
    exhaust.className = "row-exhaust";
    var reset = document.createElement("span");
    reset.className = "row-reset";
    foot.appendChild(exhaust);
    foot.appendChild(reset);

    li.appendChild(top);
    li.appendChild(bar);
    li.appendChild(foot);
    li.refs = {
      label: label,
      pctNum: pctNum,
      bar: bar,
      proj: proj,
      used: used,
      exhaust: exhaust,
      reset: reset,
    };
    return li;
  }

  function fillRow(li, w) {
    var r = li.refs;
    var used = clampPct(w.pct);
    var projected = Math.max(used, typeof w.projected_pct === "number" ? w.projected_pct : used);
    // textContent 而非 innerHTML：label 是服务端数据
    r.label.textContent = w.label;
    r.pctNum.textContent = String(Math.round(w.pct || 0));
    li.style.setProperty("--c", tone(w.pct, w.projected_pct));
    r.used.style.width = used + "%";
    r.proj.style.width = clampPct(projected) + "%";
    r.bar.classList.toggle("over", projected > 100);
    // 每行用各自的 exhaust_eta；null = 本窗口打不满，那一格就留空
    var cd = etaCountdown(w.exhaust_eta);
    r.exhaust.textContent = cd === null ? "" : "耗尽 " + cd;
    r.reset.textContent = "重置 " + resetAt(w.resets_at);
  }

  function renderRows(windows) {
    var list = el.rows;
    if (!windows || windows.length === 0) {
      list.replaceChildren();
      var empty = document.createElement("li");
      empty.className = "empty";
      empty.textContent = "—";
      list.appendChild(empty);
      return;
    }
    var rows = list.querySelectorAll("li.row");
    if (rows.length !== list.children.length) list.replaceChildren();
    while (list.children.length > windows.length) list.removeChild(list.lastElementChild);
    while (list.children.length < windows.length) list.appendChild(makeRow());
    for (var i = 0; i < windows.length; i++) fillRow(list.children[i], windows[i]);
  }

  // ---- 顶部与横幅 ---------------------------------------------------------

  /** soonest_exhaust 只给 window_kind，展示文案要去 windows 里找 label */
  function labelOfKind(windows, kind) {
    for (var i = 0; i < (windows || []).length; i++) {
      if (windows[i].window_kind === kind) return windows[i].label;
    }
    return "";
  }

  function renderHead(s) {
    var summary = s.summary;
    var head = el.eta.parentElement;
    var soonest = summary ? summary.soonest_exhaust : null;
    var cd = soonest ? etaCountdown(soonest.eta) : null;

    if (cd !== null) {
      el.eta.textContent = cd;
      var who = labelOfKind(summary.windows, soonest.window_kind);
      el.etaLabel.textContent = who ? who + " 后耗尽" : "后耗尽";
    } else {
      el.eta.textContent = "—";
      el.etaLabel.textContent = summary ? "不会耗尽" : "";
    }
    head.className = "head-eta sev-" + (summary ? worstSeverity(summary.windows) : "ok");
    el.rate.textContent = summary ? summary.rate_pct_per_min.toFixed(2) : "—";
  }

  /** 错误码 → 一句能指导动作的话。区分「凭证失效」与「服务端挂了」。 */
  function errorLine(s) {
    switch (s.errorCode) {
      case "unauthorized":
        return "凭证失效 · 到设置里更新 Token";
      case "machine_revoked":
        return "机器已吊销 · 需重新 enroll";
      case "rate_limited":
        return "被限流 · 稍后自动重试";
      case "internal":
        return "服务端故障 · 稍后自动重试";
      case "bad_request":
        return "请求被拒绝 · 检查 Profile";
      case "bad_response":
        return "响应无法解析";
      case "timeout":
        return "请求超时";
      case "network":
        return "无法连接";
      default:
        return s.error || "拉取失败";
    }
  }

  function renderBanner(s) {
    var text = "";
    var klass = "banner";
    var degraded = false;
    var old = s.snapshotAgeSeconds === null || s.snapshotAgeSeconds * 1000 >= STALE_MS;

    if (s.status === "unconfigured") {
      text = "未配置 · 填写服务器地址";
      klass += " warn";
      degraded = true;
    } else if (s.status === "auth") {
      // 凭证类错误重试没用，必须让用户看到要动手
      text = errorLine(s);
      klass += " danger";
      degraded = true;
    } else if (s.profileMismatch) {
      // 数字属于别的 profile，优先级高于陈旧：陈旧数字至少还是自己的
      text = "Profile 不一致 · 服务端 " + (s.summary ? s.summary.profile_id : "");
      klass += " danger";
      degraded = true;
    } else if (s.status === "offline") {
      text = errorLine(s) + " · 快照 " + ageText(s.snapshotAgeSeconds);
      klass += old ? " danger" : " warn";
      degraded = old;
    } else if (s.status === "stale") {
      text = "陈旧 · 快照 " + ageText(s.snapshotAgeSeconds);
      klass += " warn";
      degraded = true;
    } else if (s.status === "loading") {
      text = "获取中";
      klass += " warn";
      degraded = true;
    }

    el.banner.className = klass;
    el.banner.textContent = text;
    el.banner.hidden = text === "";
    el.main.classList.toggle("is-degraded", degraded);
  }

  // ---- 设置 ---------------------------------------------------------------

  function fillSettings(s) {
    el.serverUrl.value = s.settings.serverUrl;
    el.profileId.value = s.settings.profileId;
    el.pollSeconds.value = String(s.settings.pollSeconds);
    el.launchAtLogin.checked = s.settings.launchAtLogin;
    el.token.value = "";
    el.token.placeholder = s.settings.hasToken ? "已保存（留空不改）" : "未设置";
  }

  function showSettings(on) {
    el.settings.hidden = !on;
    el.main.hidden = on;
    if (on && state) fillSettings(state);
  }

  // ---- 主渲染 -------------------------------------------------------------

  var promptedSettings = false;

  function apply(s) {
    if (!s) return;
    state = s;
    el.root.className = s.theme === "light" ? "t-light" : "t-dark";
    // 首次运行还没填服务器地址，直接把设置摊开，省掉一次点击
    if (s.status === "unconfigured" && !promptedSettings) {
      promptedSettings = true;
      showSettings(true);
    }
    renderBanner(s);
    renderHead(s);
    renderRows(s.summary ? s.summary.windows : []);
    if (!el.settings.hidden) {
      // 正在编辑时不覆盖输入框，只同步开机自启这种外部可变的状态
      el.launchAtLogin.checked = s.settings.launchAtLogin;
    }
  }

  /** 只重排与时间有关的部分，不动表单、不发请求 */
  function retick() {
    if (!state) return;
    renderHead(state);
    renderBanner(state);
    if (state.summary) renderRows(state.summary.windows);
  }

  // ---- 事件 ---------------------------------------------------------------

  ua.subscribe(apply);
  ua.getState().then(apply);

  el.dash.addEventListener("click", function () {
    ua.openDashboard();
  });
  el.quit.addEventListener("click", function () {
    ua.quit();
  });
  el.openSettings.addEventListener("click", function () {
    showSettings(true);
  });
  el.closeSettings.addEventListener("click", function () {
    showSettings(false);
  });

  el.save.addEventListener("click", function () {
    var patch = {
      serverUrl: el.serverUrl.value,
      profileId: el.profileId.value,
      pollSeconds: Number(el.pollSeconds.value),
      launchAtLogin: el.launchAtLogin.checked,
    };
    // 空串 = 不改动；用户要清除走「清除 Token」
    if (el.token.value !== "") patch.token = el.token.value;
    el.token.value = "";
    ua.saveSettings(patch).then(function (s) {
      apply(s);
      showSettings(false);
    });
  });

  el.clearToken.addEventListener("click", function () {
    el.token.value = "";
    ua.clearToken().then(apply);
  });

  document.addEventListener("keydown", function (e) {
    if (e.key !== "Escape") return;
    if (!el.settings.hidden) showSettings(false);
    else ua.hide();
  });

  // 面板被唤出时顺手拉一次，但别让反复开关变成刷请求
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState !== "visible") return;
    retick();
    if (Date.now() - lastRefreshAt < 15000) return;
    lastRefreshAt = Date.now();
    ua.refresh().then(apply);
  });

  // 倒计时与陈旧时长自己走表，不等轮询（主进程的托盘心跳是独立的一条）
  setInterval(retick, 30000);
})();
