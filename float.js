// 悬浮球：贴边半透明，悬停展开菜单，可拖动并记住位置，可按站点隐藏（交互参照沉浸式翻译）
// 放在 Shadow DOM 里，页面样式和脚本都碰不到它，它也不会影响页面
(() => {
  if (window.top !== window) return; // 只在顶层页面显示
  const DS = globalThis.__DS;
  if (!DS) return;

  const SIZE = 40;
  const SMALL_VIEWPORT = 500; // 页面宽或高小于它（小弹层之类）就不显示
  const DRAG_THRESHOLD = 4;
  const STYLES = [["plain", "沉浸"], ["muted", "淡色"], ["underline", "下划线"], ["bar", "竖线"]];
  const TERMS = [["keep", "保留"], ["gloss", "括注"], ["translate", "翻译"]];

  let cfg = {
    floatBall: true, floatHideSites: [], floatPos: { side: "right", top: 0.45 },
    autoSites: [], neverSites: [], transStyle: "plain", termMode: "keep",
    selectTranslate: true
  };
  let host = null, root = null, ball = null, menu = null;
  let dragging = false;

  const CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; }
    .ball { position: fixed; z-index: 2147483646; width: ${SIZE}px; height: ${SIZE}px; border-radius: 50%;
      background: linear-gradient(135deg, #6366f1 0%, #8b5cf6 50%, #a855f7 100%); color: #fff; font-size: 16px; font-weight: 700; display: flex; align-items: center; justify-content: center;
      box-shadow: 0 4px 16px rgba(99, 102, 241, 0.4), inset 0 1px 1px rgba(255, 255, 255, 0.3); border: 1px solid rgba(255, 255, 255, 0.2); cursor: pointer; user-select: none; touch-action: none;
      opacity: .7; transition: transform .18s ease, opacity .18s ease, background .18s ease, box-shadow .18s ease; }
    .ball.right { right: 0; transform: translateX(45%); }
    .ball.left { left: 0; transform: translateX(-45%); }
    .ball:hover, .ball.open, .ball.drag { transform: translateX(0); opacity: 1; box-shadow: 0 6px 22px rgba(99, 102, 241, 0.55); }
    .ball.drag { transition: none; cursor: grabbing; }
    .ball.on { background: linear-gradient(135deg, #4f46e5 0%, #6366f1 100%); }
    .ball.busy::after { content: ""; position: absolute; inset: -4px; border-radius: 50%;
      border: 2px solid rgba(255,255,255,.9); border-top-color: transparent; animation: spin .8s linear infinite; }
    .badge { position: absolute; top: 1px; right: 1px; width: 10px; height: 10px; border-radius: 50%; border: 2px solid #fff; display: none; }
    .badge.fb { background: #f5a524; display: block; }
    .badge.err { background: #e5484d; display: block; }
    @keyframes spin { to { transform: rotate(360deg); } }
    .menu { position: fixed; z-index: 2147483646; width: 236px; padding: 13px; border-radius: 14px; display: none;
      background: rgba(18, 22, 34, 0.94); color: #f1f5f9; font-size: 13px; line-height: 1.4; backdrop-filter: blur(20px);
      box-shadow: 0 12px 36px rgba(0,0,0,.55), 0 0 0 1px rgba(255,255,255,.1); }
    .menu.show { display: block; }
    .title { font-weight: 700; color: #a5b4fc; display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 10px; font-size: 13px; }
    .title small { font-weight: 400; color: #94a3b8; font-size: 11px; }
    button { font: inherit; cursor: pointer; border: 0; color: inherit; }
    .primary { width: 100%; padding: 8px; border-radius: 8px; background: linear-gradient(135deg, #6366f1, #8b5cf6); color: #fff; font-weight: 600; font-size: 13px; box-shadow: 0 2px 8px rgba(99, 102, 241, 0.35); transition: opacity 0.15s; }
    .primary:hover { opacity: 0.92; }
    .primary.on { background: #262c3e; box-shadow: none; border: 1px solid rgba(255,255,255,0.1); color: #cbd5e1; }
    .row { margin-top: 10px; }
    .label { font-size: 11px; color: #94a3b8; margin-bottom: 4px; font-weight: 500; }
    .seg { display: flex; background: rgba(255,255,255,0.06); border-radius: 7px; padding: 2px; gap: 2px; border: 1px solid rgba(255,255,255,0.05); }
    .seg button { flex: 1; padding: 4px 0; border-radius: 5px; background: transparent; font-size: 12px; color: #cbd5e1; transition: all 0.15s; }
    .seg button.act { background: #6366f1; color: #fff; box-shadow: 0 1px 4px rgba(0,0,0,0.3); }
    .tog { width: 100%; display: flex; justify-content: space-between; align-items: center; padding: 6px 2px; background: transparent; font-size: 12.5px; text-align: left; color: #e2e8f0; }
    .tog i { width: 30px; height: 17px; border-radius: 9px; background: #2b3245; position: relative; flex: none; transition: background .15s; border: 1px solid rgba(255,255,255,0.08); }
    .tog i::before { content: ""; position: absolute; width: 13px; height: 13px; left: 1px; top: 1px; border-radius: 50%; background: #fff; transition: transform .15s; box-shadow: 0 1px 3px rgba(0,0,0,0.3); }
    .tog.act i { background: #6366f1; border-color: rgba(99, 102, 241, 0.4); }
    .tog.act i::before { transform: translateX(13px); }
    .sep { height: 1px; background: rgba(255,255,255,0.07); margin: 8px 0 3px; }
    .link { width: 100%; padding: 5px 2px; background: transparent; color: #94a3b8; font-size: 11.5px; text-align: left; transition: color 0.15s; }
    .link:hover { color: #f1f5f9; }
    .note { margin-top: 6px; font-size: 11px; color: #f5a524; min-height: 14px; }
    @media print { .ball, .menu { display: none !important; } }
  `;

  // ---------- 显示条件 ----------
  function shouldShow() {
    if (cfg.floatBall === false) return false;
    if (hostMatches(cfg.floatHideSites, location.hostname)) return false;
    if (innerWidth < SMALL_VIEWPORT || innerHeight < SMALL_VIEWPORT) return false;
    if (document.fullscreenElement) return false;
    return true;
  }

  function applyVisibility() {
    if (shouldShow()) {
      mount();
      host.style.display = "";
      applyPos();
      update();
    } else if (host) {
      host.style.display = "none";
      closeMenu();
    }
  }

  // ---------- 构建 ----------
  function mount() {
    if (host && host.isConnected) return;
    host = document.createElement("div");
    host.id = "deepseek-float-host";
    host.style.cssText = "all: initial; position: fixed; z-index: 2147483646; top: 0; left: 0; width: 0; height: 0;";
    root = host.attachShadow({ mode: "open" });
    root.innerHTML = `<style>${CSS}</style>
      <div class="ball right" part="ball" title="左键翻译本页，右键打开菜单">译<span class="badge"></span></div>
      <div class="menu"></div>`;
    ball = root.querySelector(".ball");
    menu = root.querySelector(".menu");
    (document.documentElement || document.body).appendChild(host);
    bindBall();
    bindMenu();
  }

  // ---------- 位置 ----------
  function applyPos() {
    if (!ball) return;
    const { side, top } = cfg.floatPos || { side: "right", top: 0.45 };
    ball.classList.toggle("left", side === "left");
    ball.classList.toggle("right", side !== "left");
    const y = Math.min(Math.max(8, Math.round(top * innerHeight)), innerHeight - SIZE - 8);
    ball.style.top = `${y}px`;
    ball.style.left = ball.style.right = ball.style.transform = "";
  }

  // ---------- 球：左键点击翻译 / 拖动 / 右键出菜单 ----------
  function bindBall() {
    let sx = 0, sy = 0, ox = 0, oy = 0, pid = null;

    ball.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      pid = e.pointerId;
      ball.setPointerCapture(pid);
      const r = ball.getBoundingClientRect();
      sx = e.clientX; sy = e.clientY; ox = r.left; oy = r.top;
      dragging = false;
      e.stopPropagation();
    });

    ball.addEventListener("pointermove", (e) => {
      if (pid !== e.pointerId) return;
      const dx = e.clientX - sx, dy = e.clientY - sy;
      if (!dragging && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
      if (!dragging) { dragging = true; ball.classList.add("drag"); closeMenu(); }
      const x = Math.min(Math.max(0, ox + dx), innerWidth - SIZE);
      const y = Math.min(Math.max(8, oy + dy), innerHeight - SIZE - 8);
      ball.style.left = `${x}px`; ball.style.right = "auto"; ball.style.top = `${y}px`;
    });

    ball.addEventListener("pointerup", (e) => {
      if (pid !== e.pointerId) return;
      ball.releasePointerCapture(pid);
      pid = null;
      if (dragging) {
        // 松手后吸附到离得近的一边，并记住位置
        const r = ball.getBoundingClientRect();
        const side = r.left + SIZE / 2 < innerWidth / 2 ? "left" : "right";
        const top = Math.min(Math.max(8, r.top), innerHeight - SIZE - 8) / innerHeight;
        ball.classList.remove("drag");
        cfg.floatPos = { side, top };
        chrome.storage.local.set({ floatPos: cfg.floatPos });
        applyPos();
        dragging = false;
      } else {
        closeMenu();
        DS.toggle();
        update();
      }
      e.stopPropagation();
    });

    // 右键才出菜单：悬停不再自动弹，避免鼠标一扫就挡住正文
    ball.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (menu && menu.classList.contains("show")) closeMenu();
      else openMenu();
    });
  }

  // ---------- 菜单 ----------
  function bindMenu() {
    menu.addEventListener("click", onMenuClick); // 事件委托：菜单重绘也不丢
    // 点页面别处就收起菜单（右键打开后不点走会一直挂着）
    document.addEventListener("pointerdown", (e) => {
      if (!menu.classList.contains("show")) return;
      const path = e.composedPath ? e.composedPath() : [];
      if (path.includes(menu) || path.includes(ball)) return;
      closeMenu();
    }, true);
  }

  const seg = (id, items, cur) =>
    `<div class="seg" data-seg="${id}">${items.map(([v, t]) => `<button data-v="${v}" class="${v === cur ? "act" : ""}">${t}</button>`).join("")}</div>`;

  function renderMenu() {
    const h = location.hostname;
    const always = hostMatches(cfg.autoSites, h), never = hostMatches(cfg.neverSites, h);
    const on = DS.isTranslated();
    const p = DS.progress();
    const status = on ? (p.pending ? `翻译中 ${p.total - p.pending - p.failed}/${p.total}` : `已译 ${p.total - p.failed}/${p.total}`) : "未翻译";
    menu.innerHTML = `
      <div class="title"><span>灵犀翻译</span><small>${status}</small></div>
      <button class="primary ${on ? "on" : ""}" data-act="toggle">${on ? "恢复原文" : "翻译此页面"}</button>
      <div class="row"><div class="label">译文样式</div>${seg("transStyle", STYLES, cfg.transStyle)}</div>
      <div class="row"><div class="label">术语处理（重新翻译后生效）</div>${seg("termMode", TERMS, cfg.termMode)}</div>
      <div class="sep"></div>
      <button class="tog ${cfg.selectTranslate !== false ? "act" : ""}" data-act="selectTranslate">划词选中翻译<i></i></button>
      <button class="tog ${always ? "act" : ""}" data-act="always">始终翻译本站<i></i></button>
      <button class="tog ${never ? "act" : ""}" data-act="never">永不自动翻译本站<i></i></button>
      <button class="link" data-act="hide">本站不显示悬浮球</button>
      <div class="note"></div>`;
    const fb = DS.fallback();
    if (fb) menu.querySelector(".note").textContent = `主模型不可用，正在使用备用模型：${fb}`;
  }

  function openMenu() {
    if (!menu || dragging) return;
    renderMenu();
    menu.classList.add("show");
    ball.classList.add("open");
    // 贴着球摆：球在右边菜单放左边，反之；竖直方向别超出屏幕
    const r = ball.getBoundingClientRect();
    const mh = menu.offsetHeight;
    menu.style.top = `${Math.min(Math.max(8, r.top - 8), innerHeight - mh - 8)}px`;
    if (cfg.floatPos.side === "left") { menu.style.left = `${SIZE + 8}px`; menu.style.right = "auto"; }
    else { menu.style.right = `${SIZE + 8}px`; menu.style.left = "auto"; }
  }

  function closeMenu() {
    if (!menu) return;
    menu.classList.remove("show");
    ball && ball.classList.remove("open");
  }

  function note(text) {
    const n = menu && menu.querySelector(".note");
    if (n) n.textContent = text;
  }

  // 菜单里的点击统一在这里处理（事件委托，菜单重绘也不丢）
  function onMenuClick(e) {
    const segBtn = e.target.closest(".seg button");
    if (segBtn) {
      const key = segBtn.parentElement.dataset.seg;
      chrome.storage.local.set({ [key]: segBtn.dataset.v });
      cfg[key] = segBtn.dataset.v;
      renderMenu();
      return;
    }
    const btn = e.target.closest("button[data-act]");
    if (!btn) return;
    const act = btn.dataset.act;
    if (act === "toggle") {
      DS.toggle();
      update();
      closeMenu();
    } else if (act === "selectTranslate") {
      const on = btn.classList.contains("act");
      cfg.selectTranslate = !on;
      chrome.storage.local.set({ selectTranslate: !on });
      renderMenu();
    } else if (act === "always" || act === "never") {
      const on = !btn.classList.contains("act");
      const res = setSiteRule(cfg.autoSites, cfg.neverSites, location.hostname, act, on);
      cfg.autoSites = res.always; cfg.neverSites = res.never;
      chrome.storage.local.set({ autoSites: res.always, neverSites: res.never });
      renderMenu();
      if (res.blockedBy) note(`被规则 ${res.blockedBy} 压着，请到弹窗的「网站规则」里修改`);
    } else if (act === "hide") {
      const h = location.hostname;
      cfg.floatHideSites = Array.from(new Set([...(cfg.floatHideSites || []), h]));
      chrome.storage.local.set({ floatHideSites: cfg.floatHideSites });
      applyVisibility();
    }
  }

  // ---------- 状态刷新 ----------
  function update() {
    if (!ball || (host && host.style.display === "none")) return;
    const on = DS.isTranslated();
    const p = DS.progress();
    ball.classList.toggle("on", on);
    ball.classList.toggle("busy", on && p.pending > 0);
    const badge = ball.querySelector(".badge");
    const fb = DS.fallback();
    badge.className = "badge" + (p.failed ? " err" : fb ? " fb" : "");
    ball.title = !on ? "左键翻译本页，右键打开菜单"
      : p.pending ? `翻译中 ${p.total - p.pending - p.failed}/${p.total}（右键打开菜单）`
      : p.failed ? `有 ${p.failed} 段翻译失败，点击译文可重试；左键恢复原文`
      : "已翻译，左键恢复原文";
    if (menu && menu.classList.contains("show")) renderMenu();
  }

  // ---------- 启动 ----------
  chrome.storage.local.get(cfg, (saved) => {
    cfg = Object.assign(cfg, saved);
    applyVisibility();
    DS.onState(update);
    setInterval(update, 500); // 译文陆续回来时刷新进度和徽标
    addEventListener("resize", applyVisibility);
    document.addEventListener("fullscreenchange", applyVisibility);
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    for (const k of Object.keys(cfg)) if (changes[k]) cfg[k] = changes[k].newValue;
    applyVisibility();
  });

})();
