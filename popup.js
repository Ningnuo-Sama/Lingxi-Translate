const DEFAULT_CONFIG = {
  apiUrl: "http://127.0.0.1:7863/v1/chat/completions",
  apiKey: "admin",
  model: "cn:deepseek-v4.1-flash",
  contextMode: true,
  autoSites: [], // 始终翻译的网站（见 rules.js 的写法）
  neverSites: [], // 永不自动翻译的网站，优先级高于上面
  autoAll: false,
  floatBall: true,
  fallbackModel: "",
  displayMode: "only",
  termMode: "keep",
  noTranslate: "",
  noThinking: true,
  transStyle: "plain",
  modelList: [], // 上次“获取模型”拿到的列表
  modelListFor: "" // 这份列表对应的接口地址，地址变了就不再沿用
};

const CUSTOM = "__custom__";
const FILTER_THRESHOLD = 12; // 模型多于这个数才显示筛选框
const FETCH_TIMEOUT_MS = 15000;

// 由聊天补全地址推出模型列表地址：.../v1/chat/completions → .../v1/models
function modelsUrl(apiUrl) {
  const u = apiUrl.trim().replace(/\/+$/, "");
  return /\/chat\/completions$/i.test(u) ? u.replace(/\/chat\/completions$/i, "/models") : `${u}/models`;
}

// 兼容 OpenAI 风格 {data:[{id}]}、{models:[...]}、纯数组、纯字符串数组
function parseModelIds(json) {
  const arr = Array.isArray(json) ? json : json?.data || json?.models || [];
  const ids = arr.map((m) => (typeof m === "string" ? m : m?.id || m?.name || m?.model)).filter(Boolean);
  return Array.from(new Set(ids)).sort((a, b) => a.localeCompare(b));
}

document.addEventListener("DOMContentLoaded", () => {
  const $ = (id) => document.getElementById(id);
  const statusEl = $("status");
  const translateBtn = $("translateBtn");
  const modelEl = $("model");
  let tabId = null;
  let hostname = "";
  let autoSites = [];
  let neverSites = [];
  let currentModel = DEFAULT_CONFIG.model;
  let fallback = "";
  let modelList = [];

  const flash = (text, color = "#10a37f") => {
    statusEl.style.color = color;
    statusEl.innerText = text;
    setTimeout(() => (statusEl.innerText = ""), 2600);
  };

  const renderBtn = (translated) => {
    translateBtn.classList.toggle("on", translated);
    translateBtn.innerText = translated ? "恢复原文" : "翻译当前页面";
  };

  // ========== 模型选择 ==========
  // 当前模型一定在选项里，哪怕它不在获取到的列表中；列表按筛选词过滤
  function renderModels() {
    const kw = $("modelFilter").value.trim().toLowerCase();
    const shown = modelList.filter((id) => !kw || id.toLowerCase().includes(kw));
    const ids = Array.from(new Set([currentModel, ...shown].filter(Boolean)));
    modelEl.innerHTML = "";
    for (const id of ids) modelEl.add(new Option(id, id));
    modelEl.add(new Option("✎ 手动输入…", CUSTOM));
    modelEl.value = currentModel;
    $("modelFilter").style.display = modelList.length > FILTER_THRESHOLD ? "block" : "none";
    $("modelCount").innerText = modelList.length ? `共 ${modelList.length} 个模型${kw ? `，筛选出 ${shown.length} 个` : ""}` : "点“获取模型”从服务端拉取列表，或手动输入";
    renderFallback();
  }

  // ========== 备用模型：主模型连续失败时自动切换（同一接口地址），列表和主模型共用 ==========
  const fbEl = $("fallbackModel");
  function renderFallback() {
    const ids = Array.from(new Set([fallback, ...modelList].filter(Boolean)));
    fbEl.innerHTML = "";
    fbEl.add(new Option("不使用备用模型", ""));
    for (const id of ids) fbEl.add(new Option(id, id));
    fbEl.add(new Option("✎ 手动输入…", CUSTOM));
    fbEl.value = fallback;
  }
  function saveFallback(v) {
    fallback = v;
    $("fallbackCustom").style.display = "none";
    renderFallback();
    chrome.storage.local.set({ fallbackModel: v }, () => {
      if (!v) flash("已关闭备用模型");
      else if (v === currentModel) flash("备用模型和主模型相同，不会生效", "#e5484d");
      else flash(`备用模型：${v}`);
    });
  }
  fbEl.addEventListener("change", () => {
    if (fbEl.value === CUSTOM) {
      fbEl.value = fallback;
      $("fallbackCustom").style.display = "block";
      $("fallbackCustom").focus();
    } else {
      saveFallback(fbEl.value);
    }
  });
  $("fallbackCustom").addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    const v = e.target.value.trim();
    if (v) { e.target.value = ""; saveFallback(v); }
  });

  // ========== 网站规则：始终翻译 / 永不自动翻译（匹配逻辑在 rules.js，页面端和这里共用） ==========
  function syncSiteUI() {
    $("autoSite").checked = !!hostname && hostMatches(autoSites, hostname);
    $("neverSite").checked = !!hostname && hostMatches(neverSites, hostname);
    $("autoRules").value = autoSites.join("\n");
    $("neverRules").value = neverSites.join("\n");
  }
  function toggleSite(kind, el) {
    if (!hostname) return;
    const res = setSiteRule(autoSites, neverSites, hostname, kind, el.checked);
    autoSites = res.always;
    neverSites = res.never;
    chrome.storage.local.set({ autoSites, neverSites }, () => {
      syncSiteUI();
      if (res.blockedBy) flash(`被规则 ${res.blockedBy} 命中，请在「网站规则」里修改`, "#e5484d");
      else flash(el.checked ? (kind === "always" ? "已加入自动翻译" : "已设为永不自动翻译") : "已取消");
    });
  }

  function chooseModel(id) {
    currentModel = id;
    $("modelCustom").style.display = "none";
    renderModels();
    chrome.storage.local.set({ model: id }, () => flash(`已切换模型：${id}`));
  }

  modelEl.addEventListener("change", () => {
    if (modelEl.value === CUSTOM) {
      modelEl.value = currentModel;
      $("modelCustom").style.display = "block";
      $("modelCustom").focus();
    } else {
      chooseModel(modelEl.value);
    }
  });
  $("modelCustom").addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    const v = e.target.value.trim();
    if (v) { e.target.value = ""; chooseModel(v); }
  });
  $("modelFilter").addEventListener("input", renderModels);

  $("fetchBtn").addEventListener("click", async () => {
    const btn = $("fetchBtn");
    const apiUrl = $("apiUrl").value.trim();
    if (!apiUrl) return flash("请先填写接口地址", "#e5484d");
    btn.disabled = true;
    btn.innerText = "获取中…";
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    try {
      const resp = await fetch(modelsUrl(apiUrl), {
        headers: { Authorization: `Bearer ${$("apiKey").value.trim()}` },
        signal: ctrl.signal
      });
      if (!resp.ok) throw new Error(resp.status === 401 || resp.status === 403 ? `密钥无效（HTTP ${resp.status}）` : `HTTP ${resp.status}`);
      const ids = parseModelIds(await resp.json());
      if (!ids.length) throw new Error("服务端返回的模型列表为空");
      modelList = ids;
      $("modelFilter").value = "";
      renderModels();
      chrome.storage.local.set({ modelList: ids, modelListFor: apiUrl });
      flash(`获取到 ${ids.length} 个模型`);
    } catch (err) {
      flash(`获取失败：${err.name === "AbortError" ? "连接超时" : err.message}`, "#e5484d");
    } finally {
      clearTimeout(timer);
      btn.disabled = false;
      btn.innerText = "获取模型";
    }
  });

  // ========== 设置回显 ==========
  chrome.storage.local.get(DEFAULT_CONFIG, (data) => {
    $("apiUrl").value = data.apiUrl;
    $("apiKey").value = data.apiKey;
    currentModel = data.model;
    modelList = data.modelListFor === data.apiUrl ? data.modelList || [] : [];
    renderModels();
    $("contextMode").checked = !!data.contextMode;
    $("autoAll").checked = !!data.autoAll;
    $("displayMode").value = data.displayMode;
    $("termMode").value = data.termMode;
    $("noTranslate").value = data.noTranslate;
    $("transStyle").value = data.transStyle;
    $("noThinking").checked = data.noThinking !== false;
    $("floatBall").checked = data.floatBall !== false;
    fallback = data.fallbackModel || "";
    renderFallback();
    autoSites = data.autoSites || [];
    neverSites = data.neverSites || [];
    syncSiteUI();
  });

  // 当前页状态（内置页等无法注入内容脚本的页面会失败，此时禁用按钮）
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    tabId = tabs[0]?.id ?? null;
    if (tabId == null) return;
    chrome.tabs.sendMessage(tabId, { action: "get-page-state" }, (res) => {
      if (chrome.runtime.lastError || !res) {
        translateBtn.disabled = true;
        translateBtn.innerText = "此页面无法翻译";
        $("siteName").innerText = "不可用";
        $("autoSite").disabled = true;
        $("neverSite").disabled = true;
        return;
      }
      hostname = res.hostname;
      $("siteName").innerText = hostname;
      $("neverSiteName").innerText = hostname;
      syncSiteUI();
      renderBtn(res.translated);
    });
  });

  // 点一下：翻译 / 恢复原文
  translateBtn.addEventListener("click", () => {
    if (tabId == null) return;
    chrome.tabs.sendMessage(tabId, { action: "toggle-page-translate" }, (res) => {
      if (chrome.runtime.lastError || !res) return flash("页面未响应，请刷新后重试", "#e5484d");
      renderBtn(res.translated);
    });
  });

  // 开关即时保存
  $("contextMode").addEventListener("change", (e) => chrome.storage.local.set({ contextMode: e.target.checked }));
  $("autoAll").addEventListener("change", (e) => chrome.storage.local.set({ autoAll: e.target.checked }));
  $("displayMode").addEventListener("change", (e) => chrome.storage.local.set({ displayMode: e.target.value, displayModeTouched: true }));
  $("transStyle").addEventListener("change", (e) => chrome.storage.local.set({ transStyle: e.target.value }));
  $("noThinking").addEventListener("change", (e) => chrome.storage.local.set({ noThinking: e.target.checked }, () => flash("下次翻译时生效")));
  $("termMode").addEventListener("change", (e) => chrome.storage.local.set({ termMode: e.target.value }, () => flash("术语设置已保存，重新翻译页面生效")));
  $("noTranslate").addEventListener("change", (e) => chrome.storage.local.set({ noTranslate: e.target.value }, () => flash("不翻译词表已保存，重新翻译页面生效")));
  $("floatBall").addEventListener("change", (e) => chrome.storage.local.set({ floatBall: e.target.checked }));
  $("autoSite").addEventListener("change", (e) => toggleSite("always", e.target));
  $("neverSite").addEventListener("change", (e) => toggleSite("never", e.target));
  $("autoRules").addEventListener("change", (e) => {
    autoSites = parseRules(e.target.value);
    chrome.storage.local.set({ autoSites }, () => { syncSiteUI(); flash("网站规则已保存"); });
  });
  $("neverRules").addEventListener("change", (e) => {
    neverSites = parseRules(e.target.value);
    chrome.storage.local.set({ neverSites }, () => { syncSiteUI(); flash("网站规则已保存"); });
  });

  // 接口设置（地址、密钥、当前模型一起保存）
  $("saveBtn").addEventListener("click", () => {
    chrome.storage.local.set({
      apiUrl: $("apiUrl").value.trim(),
      apiKey: $("apiKey").value.trim(),
      model: currentModel
    }, () => flash("✅ 设置已保存"));
  });
});
