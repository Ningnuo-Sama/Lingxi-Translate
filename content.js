let tooltipEl = null;
let session = null; // 当前页面的翻译会话：监听器、段落表、待发队列
let displayMode = "only"; // dual 双语对照 | only 仅译文（默认：沉浸，原地替换原文，不撑高版面）

// 可作为“一段文字”的块；只取不含其它块的最内层，避免重复翻译
const CAND_SEL = "p,h1,h2,h3,h4,h5,h6,li,blockquote,td,th,dd,dt,figcaption,summary,div";
const BLOCK_SEL = "p,div,li,ul,ol,table,thead,tbody,tr,td,th,h1,h2,h3,h4,h5,h6,blockquote,section,article,pre,figure,header,footer,nav,aside,form,dl,dd,dt,details,summary";
const SKIP_SEL = "#deepseek-translate-tooltip,.deepseek-dual-target,pre,code,script,style,noscript,textarea,input,select,nav,footer,[contenteditable],[translate=no],.notranslate";
const PENDING_TEXT = "翻译中…";
const insideCells = new WeakSet(); // 译文放在单元格内部的 td/th，“仅译文”模式下不隐藏它们
const MIN_LEN = 15;
const DOC_TEXT_LIMIT = 3000;
// 预取：视口下方提前约两屏、上方约半屏（沉浸式翻译同样往下预取两屏），边滚边已经译好
const prefetchMargin = () => `${Math.round(innerHeight * 0.5)}px 0px ${Math.round(innerHeight * 2)}px 0px`;
const STUCK_MS = 35000; // 发出去超过这么久还没回来，视为丢了
const MAX_RESENDS = 2; // 自动重发的次数上限
const WATCH_MS = 5000;
const FLUSH_DELAY = 200;
const RESCAN_DELAY = 600;
const CHUNK_SIZE = 24;

// 创建划词气泡
function ensureTooltip() {
  if (!tooltipEl) {
    tooltipEl = document.createElement("div");
    tooltipEl.id = "deepseek-translate-tooltip";
    document.body.appendChild(tooltipEl);
  }
  return tooltipEl;
}

// 取选区所在段落，作为划词翻译的语境
function selectionContext() {
  const sel = window.getSelection();
  const node = sel.anchorNode && (sel.anchorNode.nodeType === 1 ? sel.anchorNode : sel.anchorNode.parentElement);
  const para = node && node.closest ? node.closest(CAND_SEL) || node : null;
  return {
    title: document.title,
    around: para && para.innerText ? para.innerText.trim().slice(0, 500) : ""
  };
}

// 划词监听
document.addEventListener("mouseup", (e) => {
  const selection = window.getSelection().toString().trim();
  if (!selection || selection.length < 2) {
    if (tooltipEl) tooltipEl.style.display = "none";
    return;
  }
  if (e.target.closest && e.target.closest("#deepseek-translate-tooltip")) return;

  const tooltip = ensureTooltip();
  tooltip.innerText = "DeepSeek 正在思考翻译...";
  tooltip.style.left = `${e.pageX + 10}px`;
  tooltip.style.top = `${e.pageY + 15}px`;
  tooltip.style.display = "block";

  chrome.runtime.sendMessage({ action: "translate", text: selection, context: selectionContext() }, (res) => {
    if (res?.success) {
      tooltip.innerText = res.translation;
    } else {
      tooltip.innerText = `翻译失败: ${res?.error || "服务未响应"}`;
    }
  });
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.action === "toggle-page-translate") {
    togglePageTranslate();
    sendResponse({ translated: isTranslated() });
    return;
  }
  if (msg.action === "get-page-state") {
    sendResponse({ translated: isTranslated(), hostname: location.hostname });
    return;
  }
  // 以下为后台回传，jobId 不一致说明是已取消的旧任务
  if (!session || msg.jobId !== session.jobId) return;
  if (msg.action === "page-batch-result") {
    fallbackModel = msg.fallback || ""; // 后台正在用备用模型时给悬浮球提示
    for (const it of msg.items) {
      const item = session.items.get(it.id);
      if (!item) continue;
      if (it.ok) {
        item.node.innerText = it.text;
        item.node.classList.remove("deepseek-dual-pending", "deepseek-dual-failed");
      } else {
        item.node.innerText = "[翻译失败，点击重试]";
        item.node.classList.remove("deepseek-dual-pending");
        item.node.classList.add("deepseek-dual-failed");
      }
    }
  }
});

function isTranslated() {
  return session !== null;
}

// ========== 给悬浮球用的接口（同一个隔离世界里的 float.js 通过 __DS 访问） ==========
let fallbackModel = "";
const stateListeners = [];
const notifyState = () => stateListeners.forEach((fn) => { try { fn(); } catch (_) {} });

// 翻译进度：total 已送去翻译的段数，pending 还在等结果，failed 失败待重试
function progress() {
  let pending = 0, failed = 0;
  if (session) {
    for (const { node } of session.items.values()) {
      if (node.classList.contains("deepseek-dual-pending")) pending++;
      else if (node.classList.contains("deepseek-dual-failed")) failed++;
    }
  }
  return { total: session ? session.items.size : 0, pending, failed };
}

globalThis.__DS = {
  toggle: () => { togglePageTranslate(); },
  isTranslated: () => isTranslated(),
  progress,
  fallback: () => fallbackModel,
  onState: (fn) => stateListeners.push(fn)
};

// ========== 候选段落 ==========
function isMostlyCJK(text) {
  const sample = text.slice(0, 2000);
  return (sample.match(/[一-鿿]/g) || []).length / Math.max(sample.length, 1) > 0.3;
}

// 返回可翻译文本；不符合条件返回 ""
function candidateText(el) {
  if (el.closest(SKIP_SEL) || el.querySelector(BLOCK_SEL)) return "";
  if (el.getClientRects().length === 0) return ""; // 不可见
  const text = el.innerText ? el.innerText.trim() : "";
  if (text.length < MIN_LEN) return "";
  if (!/[A-Za-zÀ-ɏЀ-ӿ぀-ヿ가-힯]/.test(text)) return ""; // 纯数字符号
  if (isMostlyCJK(text)) return ""; // 已经是中文，无需翻译
  return text;
}

function collectCandidates() {
  const out = [];
  for (const el of document.querySelectorAll(CAND_SEL)) {
    if (session.seen.has(el)) continue;
    const text = candidateText(el);
    if (text) out.push({ el, text });
  }
  return out;
}

function observeAll(cands) {
  for (const { el } of cands) {
    session.seen.add(el);
    session.io.observe(el);
  }
}

// ========== 懒翻译：进入（接近）视口才送去翻译 ==========
function onIntersect(entries) {
  if (!session) return;
  for (const e of entries) {
    if (!e.isIntersecting) continue;
    session.io.unobserve(e.target);
    enqueue(e.target);
  }
}

function enqueue(el) {
  if (!session || !el.isConnected) return;
  const text = candidateText(el);
  if (!text) return;

  const id = session.nextId++;
  const node = document.createElement("div");
  node.className = "deepseek-dual-target deepseek-dual-pending";
  node.innerText = PENDING_TEXT;
  node.addEventListener("click", () => {
    if (node.classList.contains("deepseek-dual-failed")) retry(id);
  });
  matchOriginalLook(el, node);
  // 表格单元格里不能在 <tr> 下直接塞 div，译文放进单元格内部；其余放在原文后面
  const isCell = /^(TD|TH)$/.test(el.tagName);
  const origHTML = isCell ? el.innerHTML : "";
  if (isCell) {
    insideCells.add(el);
    // 译文留在单元格里；仅译文模式把原文藏进隐藏的包装元素，dual 模式原文照旧
    el.replaceChildren(node);
    applyCellMode(el, node, origHTML);
  } else {
    el.insertAdjacentElement("afterend", node);
  }
  session.items.set(id, { el, node, text, origHTML, sentAt: 0, tries: 0 });
  applyHide(el);
  session.pending.push({ id, text, el });
  scheduleFlush();
}

function retry(id) {
  const item = session && session.items.get(id);
  if (!item) return;
  item.tries = 0;
  item.node.innerText = PENDING_TEXT;
  item.node.classList.remove("deepseek-dual-failed");
  item.node.classList.add("deepseek-dual-pending");
  session.pending.push({ id, text: item.text, el: item.el });
  scheduleFlush();
}

function scheduleFlush() {
  if (session.flushTimer) return;
  session.flushTimer = setTimeout(flush, FLUSH_DELAY);
}

function flush() {
  if (!session) return;
  session.flushTimer = null;
  const batch = session.pending.splice(0);
  if (!batch.length) return;
  // 按文档顺序送出，术语与前文窗口才连贯
  batch.sort((a, b) => (a.el.compareDocumentPosition(b.el) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
  const now = Date.now();
  for (let i = 0; i < batch.length; i += CHUNK_SIZE) {
    const chunk = batch.slice(i, i + CHUNK_SIZE);
    for (const { id } of chunk) {
      const item = session.items.get(id);
      if (item) item.sentAt = now;
    }
    // 标题和摘要文本每块都带上：后台脚本被系统回收后能凭它重建任务，不会丢段落
    chrome.runtime.sendMessage({
      action: "translate-chunk",
      jobId: session.jobId,
      title: session.title,
      docText: session.docText,
      items: chunk.map(({ id, text }) => ({ id, text }))
    });
  }
}

// 兜底：发出去很久还没回来的段落（后台被回收、消息丢失等）自动重发，重发仍无果就标成失败让用户点击重试
function checkStuck() {
  if (!session) return;
  const now = Date.now();
  for (const [id, item] of session.items) {
    if (!item.sentAt || !item.node.classList.contains("deepseek-dual-pending")) continue;
    if (now - item.sentAt < STUCK_MS) continue;
    if (++item.tries > MAX_RESENDS) {
      item.node.innerText = "[翻译失败，点击重试]";
      item.node.classList.remove("deepseek-dual-pending");
      item.node.classList.add("deepseek-dual-failed");
    } else {
      item.sentAt = now;
      session.pending.push({ id, text: item.text, el: item.el });
      scheduleFlush();
    }
  }
}

// ========== 动态页面：监听新出现的内容与页面切换 ==========
function onMutation(records) {
  if (!session) return;
  const relevant = records.some((r) =>
    Array.from(r.addedNodes).some((n) => n.nodeType === 1 && !n.classList.contains("deepseek-dual-target"))
  );
  if (!relevant && location.href === session.url) return;
  if (session.scanTimer) return;
  session.scanTimer = setTimeout(rescan, RESCAN_DELAY);
}

function rescan() {
  if (!session) return;
  session.scanTimer = null;
  if (location.href !== session.url) {
    // 单页应用切换了页面：重开一次会话，重新提取上下文
    stopSession();
    startSession();
    return;
  }
  observeAll(collectCandidates());
}

// ========== 会话 ==========
function startSession() {
  const jobId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  session = {
    jobId,
    url: location.href,
    items: new Map(),
    seen: new WeakSet(),
    pending: [],
    nextId: 1,
    flushTimer: null,
    scanTimer: null,
    title: document.title,
    docText: "",
    watchTimer: setInterval(checkStuck, WATCH_MS),
    io: new IntersectionObserver(onIntersect, { rootMargin: prefetchMargin() }),
    mo: new MutationObserver(onMutation)
  };

  const cands = collectCandidates();
  session.docText = cands.map((c) => c.text).join("\n").slice(0, DOC_TEXT_LIMIT);
  chrome.runtime.sendMessage({
    action: "translate-page",
    jobId,
    title: document.title,
    url: location.href,
    docText: session.docText
  });
  observeAll(cands);
  session.mo.observe(document.body, { childList: true, subtree: true });
  notifyState();
}

function stopSession() {
  if (!session) return;
  session.io.disconnect();
  session.mo.disconnect();
  clearTimeout(session.flushTimer);
  clearTimeout(session.scanTimer);
  clearInterval(session.watchTimer);
  for (const { el, node, origHTML } of session.items.values()) {
    node.remove();
    // 仅译文模式下单元格原文被藏进包装元素，这里还原回去
    if (insideCells.has(el)) {
      const wrap = el.querySelector(":scope > .deepseek-orig-wrap");
      if (wrap) wrap.remove();
      if (origHTML) el.innerHTML = origHTML;
      insideCells.delete(el);
    }
    el.classList.remove("deepseek-hide-orig");
  }
  session = null;
  fallbackModel = "";
  chrome.runtime.sendMessage({ action: "cancel-page-translate" });
  notifyState();
}

function togglePageTranslate() {
  if (isTranslated()) stopSession();
  else startSession();
}

// 显示模式：仅译文时隐藏原文，切回双语时恢复
function applyHide(el) {
  el.classList.toggle("deepseek-hide-orig", displayMode === "only" && !insideCells.has(el));
}

// 单元格单独处理：译文一直在单元格里（不能塞到 <tr> 下），所以要靠“藏原文”实现仅译文。
//   only —— 原文包进一个隐藏的 span，单元格里只剩译文，行高不会被撑成两行
//   dual —— 原文照旧显示，译文接在下面（上下两行对照）
function applyCellMode(el, node, origHTML) {
  const wrap = el.querySelector(":scope > .deepseek-orig-wrap");
  if (displayMode === "only") {
    if (!wrap) {
      const w = document.createElement("span");
      w.className = "deepseek-orig-wrap";
      w.innerHTML = origHTML || "";
      el.replaceChildren(w, node);
    }
  } else {
    if (wrap) wrap.remove();
    el.replaceChildren();
    if (origHTML) el.innerHTML = origHTML;
    el.appendChild(node);
  }
}

function applyDisplayMode() {
  if (!session) return;
  for (const { el, node, origHTML } of session.items.values()) {
    if (insideCells.has(el)) applyCellMode(el, node, origHTML);
    else applyHide(el);
  }
}

// 让译文长得像原文：字体、字号、字重、行高、颜色都照原文来（标题的译文也是标题大小），
// 再把原文下方的外边距“收”回来，使译文紧贴原文，而不是隔着一大段空白
function matchOriginalLook(el, node) {
  const cs = getComputedStyle(el);
  const set = (k, v) => node.style.setProperty(k, v, "important");
  set("font-family", cs.fontFamily);
  set("font-size", cs.fontSize);
  set("font-weight", cs.fontWeight);
  set("font-style", cs.fontStyle);
  set("line-height", cs.lineHeight);
  set("letter-spacing", cs.letterSpacing);
  set("text-align", cs.textAlign);
  node.style.setProperty("--ds-color", cs.color);
  if (!/^(TD|TH)$/.test(el.tagName)) {
    const mb = cs.marginBottom;
    if (displayMode === "only") {
      // 仅译文：原文整块隐藏、它的上下边距也没了，译文自己按原文的边距收尾
      set("margin-top", cs.marginTop);
    } else {
      set("margin-top", `calc(3px - ${mb})`); // 与原文自己的下边距相消，只留 3px 间隔
    }
    set("margin-bottom", mb);
    set("margin-left", cs.marginLeft);
    set("margin-right", cs.marginRight);
    set("padding-left", cs.paddingLeft);
  }
}

function applyStyleMode(mode) {
  document.documentElement.setAttribute("data-ds-style", mode || "plain");
}

// ========== 设置联动：显示模式 / 自动翻译 ==========
function pageMostlyCJK() {
  return isMostlyCJK(document.body && document.body.innerText ? document.body.innerText : "");
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.displayMode) {
    displayMode = changes.displayMode.newValue || "only";
    applyDisplayMode();
  }
  if (changes.transStyle) applyStyleMode(changes.transStyle.newValue);
});

// 页面加载后按设置自动翻译：命中“自动翻译的网站”，或开启了“自动翻译所有外文页”且当前页不是中文。
// “永不翻译的网站”优先级最高，命中就不自动翻译（手动点按钮、悬浮球、Alt+A 仍然可以）
chrome.storage.local.get({ autoSites: [], neverSites: [], autoAll: false, displayMode: "only", transStyle: "plain" }, (cfg) => {
  displayMode = cfg.displayMode;
  applyStyleMode(cfg.transStyle);
  const run = () => {
    if (isTranslated()) return;
    if (hostMatches(cfg.neverSites, location.hostname)) return;
    const hit = hostMatches(cfg.autoSites, location.hostname);
    if (hit || (cfg.autoAll && !pageMostlyCJK())) startSession();
  };
  if (document.readyState === "complete") setTimeout(run, 800);
  else window.addEventListener("load", () => setTimeout(run, 800), { once: true });
});
