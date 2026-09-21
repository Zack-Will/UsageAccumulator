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
    var midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    var days = Math.floor((new Date(t.getFullYear(), t.getMonth(), t.getDate()) - midnight) / 86400e3);
    if (days === 0) return hm;
    if (days === 1) return "明天 " + hm;
    return t.getMonth() + 1 + "/" + t.getDate() + " " + hm;
  }

  /** 额度快照的年龄文案。参数来自 captured_at，不是本次请求时刻。 */
  function ageText(seconds) {
    if (seconds === null || seconds === undefined) return "无数据";
    if (seconds < 90) return "刚刚";
    var min = Math.round(seconds / 60);
    if (min < 60) return min + " 分钟前";
    return Math.round(min / 60) + " 小时前";
  }

  /**
   * 百分比的颜色。复刻 UsageStatusCalculator.calculateStatus。
   *
   * ★ 关键是**配速感知**：时间过了 15% 之后，看的不是「已经用了多少」，
   * 而是「按这个速度到期末会用到多少」。所以 5h 窗口刚开就用掉 30%
   * 会是红的，而 7d 窗口第 6 天用到 85% 反而是安全的 —— 这比单看绝对值有用得多。
   */
  function statusColorVar(pct, elapsed) {
    var u = (pct || 0) / 100;
    if (elapsed !== null && elapsed >= 0.15 && elapsed < 1 && u > 0) {
      var projected = u / elapsed;
      if (projected < 0.7) return "--sys-green";
      if (projected < 0.9) return "--sys-orange";
      return "--sys-red";
    }
    if (pct < 70) return "--sys-green";
    if (pct < 90) return "--sys-orange";
    return "--sys-red";
  }

  /** 配速刻度自身的颜色。复刻 PaceStatus：六档，比状态色更细。 */
  function paceColorVar(pct, elapsed) {
    if (elapsed === null || elapsed < 0.03 || elapsed >= 1) return "--sys-label";
    if (!(pct > 0)) return "--sys-green";
    var projected = (pct / 100) / elapsed;
    if (projected < 0.5) return "--sys-green";
    if (projected < 0.75) return "--sys-teal";
    if (projected < 0.9) return "--sys-yellow";
    if (projected < 1.0) return "--sys-orange";
    if (projected < 1.2) return "--sys-red";
    return "--sys-purple";
  }

  // ---- 行 -----------------------------------------------------------------

  /**
   * window_kind → 展示用的标题 / 徽章 / 副标题。
   *
   * window_kind 是稳定 key（契约 §2.1a），展示文案属于展示层，所以映射放在这里；
   * 没见过的 kind 回退到服务端给的 label，保证新窗口出现时不至于空白。
   * 副标题只在徽章说不清楚时才给 —— 五小时窗口没有徽章，就靠它。
   */
  var WINDOW_META = {
    five_hour: { title: "会话使用量", sub: "5 小时滚动窗口", len: 5 * 3600e3 },
    seven_day: { title: "所有模型", badge: "每周", len: 7 * 86400e3 },
  };

  function metaOf(w) {
    var m = WINDOW_META[w.window_kind];
    if (m) return m;
    // seven_day_fable / seven_day_opus… → 「Fable」+「每周」
    var perModel = /^seven_day_(.+)$/.exec(w.window_kind || "");
    if (perModel) {
      var name = perModel[1].replace(/_/g, " ");
      return { title: name.charAt(0).toUpperCase() + name.slice(1), badge: "每周", len: 7 * 86400e3 };
    }
    return { title: w.label || w.window_kind || "—" };
  }

  /**
   * 窗口已经走过的时间比例，0..100 —— 即「按时间匀速消耗，此刻应该在的位置」。
   * 只有知道窗口长度才算得出来；未知 kind 返回 null，那条就不画刻度：
   * 宁可不画，也不要画一根位置是猜的线。
   */
  function paceFrac(w, meta) {
    if (!meta || !meta.len) return null;
    var end = new Date(w.resets_at);
    if (isNaN(end.getTime())) return null;
    var remain = end.getTime() - Date.now();
    if (remain <= 0) return 1;
    if (remain > meta.len) return null;
    return Math.min(1, Math.max(0, (meta.len - remain) / meta.len));
  }

  function makeRow() {
    var li = document.createElement("li");
    li.className = "row";

    var head = document.createElement("div");
    head.className = "row-head";
    var name = document.createElement("div");
    name.className = "row-name";
    var nameTop = document.createElement("div");
    nameTop.className = "row-name__top";
    var label = document.createElement("span");
    label.className = "row-label";
    var badge = document.createElement("span");
    badge.className = "badge";
    badge.hidden = true;
    nameTop.appendChild(label);
    nameTop.appendChild(badge);
    var sub = document.createElement("div");
    sub.className = "row-sub";
    sub.hidden = true;
    name.appendChild(nameTop);
    name.appendChild(sub);

    // 不加 num：等宽字体是我们自己的习惯，参考实现用的是系统字体
    var pct = document.createElement("span");
    pct.className = "row-pct";
    var pctNum = document.createElement("span");
    var unit = document.createElement("span");
    unit.className = "unit";
    unit.textContent = "%";
    pct.appendChild(pctNum);
    pct.appendChild(unit);
    head.appendChild(name);
    head.appendChild(pct);

    var bar = document.createElement("div");
    bar.className = "bar";
    var used = document.createElement("span");
    used.className = "bar-used";
    var pace = document.createElement("span");
    pace.className = "bar-pace";
    pace.hidden = true;
    bar.appendChild(used);
    bar.appendChild(pace);

    var foot = document.createElement("div");
    foot.className = "row-foot";
    var reset = document.createElement("span");
    reset.className = "row-reset";
    foot.appendChild(reset);

    li.appendChild(head);
    li.appendChild(bar);
    li.appendChild(foot);
    li.refs = {
      label: label,
      badge: badge,
      sub: sub,
      pctNum: pctNum,
      bar: bar,
      used: used,
      pace: pace,
      reset: reset,
    };
    return li;
  }

  function fillRow(li, w) {
    var r = li.refs;
    var meta = metaOf(w);
    var used = clampPct(w.pct);
    var projected = Math.max(used, typeof w.projected_pct === "number" ? w.projected_pct : used);

    // textContent 而非 innerHTML：这些都是服务端数据
    r.label.textContent = meta.title;
    r.badge.textContent = meta.badge || "";
    r.badge.hidden = !meta.badge;
    r.sub.textContent = meta.sub || "";
    r.sub.hidden = !meta.sub;

    r.pctNum.textContent = String(Math.round(w.pct || 0));

    var elapsed = paceFrac(w, meta);
    li.style.setProperty("--c", "var(" + statusColorVar(w.pct || 0, elapsed) + ")");
    li.style.setProperty("--pace", "var(" + paceColorVar(w.pct || 0, elapsed) + ")");

    r.used.style.width = used + "%";
    r.bar.classList.toggle("over", projected > 100);

    r.pace.hidden = elapsed === null || elapsed >= 1;
    if (!r.pace.hidden) r.pace.style.left = (elapsed * 100) + "%";

    r.reset.textContent = w.resets_at ? "重置时间 " + resetAt(w.resets_at) : "";
  }

  /**
   * 哪些窗口值得进 UI。
   *
   * 官方响应里有一批代号字段（nimbus_quill / amber_gauge / juniper_tide…），
   * 多数是 null，少数带 utilization: 0。解析层刻意「不认识也原样带出」以防字段改名，
   * 但那是**存储**的策略，不是展示的策略 —— 没有重置时刻又零用量的东西，
   * 放进面板只会是噪音。两个条件同时成立才丢，避免误杀真窗口。
   */
  function isMeaningful(w) {
    return Boolean(w.resets_at) || (w.pct || 0) > 0;
  }

  function renderRows(all) {
    var windows = (all || []).filter(isMeaningful);
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
    renderRows(s.summary ? s.summary.windows : []);
    if (!el.settings.hidden) {
      // 正在编辑时不覆盖输入框，只同步开机自启这种外部可变的状态
      el.launchAtLogin.checked = s.settings.launchAtLogin;
    }
  }

  /** 只重排与时间有关的部分，不动表单、不发请求 */
  function retick() {
    if (!state) return;
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
