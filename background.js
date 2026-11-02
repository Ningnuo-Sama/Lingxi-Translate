const DEFAULT_CONFIG = {
  apiUrl: "http://127.0.0.1:7863/v1/chat/completions",
  apiKey: "admin",
  model: "cn:deepseek-v4.1-flash",
  autoHover: true,
  contextMode: true, // 上下文精翻：文档摘要 + 术语表 + 批处理 + 滑动窗口
  termMode: "keep", // 术语处理：keep 保留原文 | gloss 首次括注 | translate 翻译
  noTranslate: "", // 不翻译词表：一行一个，永远保持原样
  fallbackModel: "", // 备用模型：主模型连续失败时自动切换，同一接口地址；留空则不启用
  noThinking: true, // 关闭模型“思考”：翻译不需要推理，关掉后更快更稳
  transStyle: "plain", // 译文样式，给页面端用：plain 无装饰 | muted 淡色 | underline 下划线 | bar 竖线底色
  displayMode: "only", // 显示方式：only 仅译文（沉浸，默认）| dual 双语对照
  selectTranslate: true // 划词选中翻译：选中文本后自动弹出气泡翻译
};

// 一次性迁移：老版本默认是「双语对照」，用户没主动改过就升级成「仅译文」；
// 用户自己选过的（displayModeTouched）一律尊重，不再动
function migrateDefaults(details) {
  chrome.storage.local.get(null, (data) => {
    const patch = {};
    if (!data.apiUrl) Object.assign(patch, DEFAULT_CONFIG);
    if (details.reason === "update" && !data.displayModeTouched && data.displayMode !== "only") {
      patch.displayMode = "only";
    }
    if (Object.keys(patch).length) chrome.storage.local.set(patch);
  });
}

chrome.runtime.onInstalled.addListener((details) => migrateDefaults(details));

const TARGET = "简体中文";
const MAX_PARALLEL = 5; // 同时在飞的批次数（实际还受下面的全局上限约束）
// 网关实测：6 路并发全部正常，第 7 路起返回 503 no_healthy_account，限流后单发立刻恢复。
// 读全文、批次、逐段降级、划词共用同一个上限，留一路余量
const MAX_INFLIGHT = 5;
const CTX_WAIT_MS = 2500; // 第一批最多等“读全文”这么久，超时就先翻，别让首屏干等
const BATCH_MAX_ITEMS = 8;
const BATCH_MAX_CHARS = 1500;
const DOC_TEXT_LIMIT = 3000; // “读全文”只取开头这么多字，够判断主题和术语，也更快
const TERMS_IN_PROMPT_LIMIT = 80;
const REQUEST_TIMEOUT_MS = 90000;
const CACHE_MAX = 1500;

// 每个标签页同时只有一个整页任务：术语表、前文窗口都挂在任务上，跨分块滚动积累
const jobs = new Map();

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "translate") {
    chrome.storage.local.get(DEFAULT_CONFIG, async (cfg) => {
      try {
        const result = request.context
          ? await translateSelection(request.text, request.context, cfg)
          : await callDeepSeek(request.text, cfg);
        sendResponse({ success: true, translation: result });
      } catch (err) {
        sendResponse({ success: false, error: err.message });
      }
    });
    return true; // 异步响应
  }

  const tabId = sender.tab?.id;
  if (tabId == null) return;

  if (request.action === "translate-page") {
    createJob(tabId, request);
    sendResponse({ started: true });
    return;
  }

  if (request.action === "translate-chunk") {
    let job = jobs.get(tabId);
    if (job && job.jobId !== request.jobId) return; // 已被新任务取代，旧分块作废
    // MV3 的后台脚本空闲约 30 秒就会被回收，内存里的任务表随之丢失。
    // 用户往下滚时新分块到来却找不到任务，要靠分块里带的标题和摘要文本就地重建，不能丢
    if (!job) job = createJob(tabId, request);
    // 分块并发处理，批次数由 acquire/release 限流；术语表在各批完成时随时合并
    busyStart();
    processChunk(tabId, job, request.items)
      .catch((err) => {
        sendToTab(tabId, { action: "page-batch-result", jobId: job.jobId, items: request.items.map((it) => ({ id: it.id, text: "", ok: false })), error: err.message });
      })
      .finally(busyEnd);
    return;
  }

  if (request.action === "cancel-page-translate") {
    jobs.delete(tabId);
  }
});

// 登记一个整页任务。设置异步加载，分块处理时等 ready，避免首块先到而读到默认设置
function createJob(tabId, req) {
  const job = {
    jobId: req.jobId,
    title: req.title || "",
    docText: (req.docText || "").slice(0, DOC_TEXT_LIMIT),
    cfg: DEFAULT_CONFIG,
    ready: null,
    ctxPromise: null,
    termMap: new Map(),
    glossed: new Set(), // 首次括注模式下，已经括注过的术语
    glossSeen: new Set(), // 译文里已经出现过括注的英文原文（小写），后处理用
    userKeep: [],
    prevPairs: [],
    ctx: null, // 文档上下文提取完成后填入，批次不必干等
    running: 0, // 并发批次计数与等待队列
    waiters: []
  };
  job.ready = new Promise((resolve) => {
    chrome.storage.local.get(DEFAULT_CONFIG, (cfg) => {
      job.cfg = cfg;
      job.userKeep = parseNoTranslate(cfg.noTranslate);
      resolve();
    });
  });
  jobs.set(tabId, job);
  return job;
}

// 翻译进行中让后台脚本别被回收：定时调一下扩展 API 可以重置空闲计时
let busyCount = 0;
let keepAliveTimer = null;
function busyStart() {
  if (busyCount++ === 0) keepAliveTimer = setInterval(() => { try { chrome.runtime.getPlatformInfo(() => void chrome.runtime.lastError); } catch (_) {} }, 20000);
}
function busyEnd() {
  if (--busyCount <= 0) { busyCount = 0; clearInterval(keepAliveTimer); keepAliveTimer = null; }
}

// 监听快捷键 Alt+A 触发整页双语对照
chrome.commands.onCommand.addListener((command) => {
  if (command === "toggle-translation") {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]?.id) {
        chrome.tabs.sendMessage(tabs[0].id, { action: "toggle-page-translate" });
      }
    });
  }
});

function sendToTab(tabId, msg) {
  try {
    chrome.tabs.sendMessage(tabId, msg, () => void chrome.runtime.lastError);
  } catch (_) {}
}

// ========== 统一的大模型调用出口：超时 + 一次重试 ==========
// 关闭思考用的是 thinking:{type:"disabled"}；个别服务端会因未知参数返回 400，
// 遇到就记下这个接口不支持，同一次请求去掉参数重发，之后也不再带
const thinkingRejected = new Set();

// 全局在途请求限流：所有模型调用都先领名额，超过 MAX_INFLIGHT 的排队等
let inflight = 0;
const inflightWaiters = [];
const llmAcquire = () => (inflight < MAX_INFLIGHT ? (inflight++, Promise.resolve()) : new Promise((r) => inflightWaiters.push(r)));
const llmRelease = () => {
  const next = inflightWaiters.shift();
  if (next) next(); // 名额直接转给排队的下一个
  else inflight--;
};

async function callOnce(messages, cfg, { temperature = 0.3, retries = 2, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    // 重试前先退避一小会儿（第 1 次约 0.4s、第 2 次约 0.8s，带随机抖动），限流时别立刻再撞上去
    if (attempt > 0) await new Promise((r) => setTimeout(r, 400 * 2 ** (attempt - 1) + Math.random() * 200));
    await llmAcquire();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const sendThinkingOff = cfg.noThinking !== false && !thinkingRejected.has(cfg.apiUrl);
      const body = { model: cfg.model, messages, temperature };
      if (sendThinkingOff) body.thinking = { type: "disabled" };
      const resp = await fetch(cfg.apiUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${cfg.apiKey}`
        },
        body: JSON.stringify(body),
        signal: ctrl.signal
      });
      if (!resp.ok) {
        const errText = await resp.text();
        if (resp.status === 400 && sendThinkingOff) {
          thinkingRejected.add(cfg.apiUrl);
          attempt--; // 这次不算重试次数，去掉参数直接再发
          continue;
        }
        throw new Error(`HTTP ${resp.status}: ${errText.slice(0, 80)}`);
      }
      const data = await resp.json();
      const text = stripThink(data.choices?.[0]?.message?.content || "");
      if (!text) throw new Error("模型返回了空内容");
      return text;
    } catch (err) {
      lastErr = err.name === "AbortError" ? new Error("请求超时") : err;
    } finally {
      clearTimeout(timer);
      llmRelease();
    }
  }
  throw lastErr;
}

function stripThink(s) {
  return s.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}

// ========== 备用模型自动切换（断路器） ==========
// 主模型失败：这一次请求立刻改用备用模型补上；连续失败 BREAKER_FAILS 次后，主模型“冷却”
// BREAKER_COOLDOWN_MS，期间直接走备用，不再每次白等一轮失败；冷却结束自动再试主模型。
const BREAKER_FAILS = 2;
const BREAKER_COOLDOWN_MS = 120000;
const FALLBACK_TIMEOUT_MS = 45000; // 配了备用模型时，主模型别拖 90 秒才放弃
const breakers = new Map(); // `${apiUrl}|${model}` → { fails, until, lastFallbackAt }

const breakerOf = (cfg) => {
  const key = `${cfg.apiUrl}|${cfg.model}`;
  if (!breakers.has(key)) breakers.set(key, { fails: 0, until: 0, lastFallbackAt: 0 });
  return breakers.get(key);
};

// 最近是否在用备用模型：给页面端提示用
function fallbackInUse(cfg) {
  const fb = (cfg.fallbackModel || "").trim();
  if (!fb || fb === cfg.model) return "";
  const b = breakerOf(cfg);
  return Date.now() - b.lastFallbackAt < 15000 || Date.now() < b.until ? fb : "";
}

async function callLLM(messages, cfg, opts = {}) {
  const fb = (cfg.fallbackModel || "").trim();
  if (!fb || fb === cfg.model) return callOnce(messages, cfg, opts);

  const b = breakerOf(cfg);
  const useFallback = () => {
    b.lastFallbackAt = Date.now();
    return callOnce(messages, { ...cfg, model: fb }, opts);
  };
  if (Date.now() < b.until) return useFallback(); // 主模型冷却中

  try {
    const r = await callOnce(messages, cfg, { ...opts, retries: 0, timeoutMs: FALLBACK_TIMEOUT_MS });
    b.fails = 0;
    return r;
  } catch (primaryErr) {
    if (++b.fails >= BREAKER_FAILS) {
      b.until = Date.now() + BREAKER_COOLDOWN_MS;
      b.fails = 0;
    }
    try {
      return await useFallback();
    } catch (fbErr) {
      throw new Error(`主模型失败（${primaryErr.message}），备用模型也失败（${fbErr.message}）`);
    }
  }
}

// 已经以中文为主的文本不需要翻译
function isMostlyCJK(text) {
  const sample = text.slice(0, 2000);
  return (sample.match(/[一-鿿]/g) || []).length / Math.max(sample.length, 1) > 0.3;
}

// ========== 单段 / 划词翻译 ==========
// 不翻译词表：一行一个（也接受逗号/分号分隔），大小写不敏感去重
function parseNoTranslate(s) {
  const seen = new Set();
  const out = [];
  for (const w of String(s || "").split(/[\n,，;；]+/)) {
    const t = w.trim();
    if (t && !seen.has(t.toLowerCase())) {
      seen.add(t.toLowerCase());
      out.push(t);
    }
  }
  return out.slice(0, 200);
}

// 括注模式下模型偶尔会写出 “Copilot（Copilot）” 这种原文括注原文的冗余，确定性清掉
const dedupeGloss = (text) => text.replace(/([A-Za-z0-9][A-Za-z0-9 .+#_-]*?)\s*[（(]\s*\1\s*[）)]/g, "$1");

// 括注后处理（模型执行不稳，不能只靠提示词）：
// 1) 含大写字母才算专有名词/技术术语，小写普通名词（data centers）不括注；
// 2) 同一个术语整页只在首次出现时括注，之后（包括后面的分块）一律去掉括注
function polishGloss(text, job) {
  return dedupeGloss(text).replace(/\s*（\s*([A-Za-z][A-Za-z0-9 .+#_&'-]*?)\s*）/g, (m, en) => {
    if (!/[A-Z]/.test(en)) return "";
    const k = en.toLowerCase();
    if (job.glossSeen.has(k)) return "";
    job.glossSeen.add(k);
    return m;
  });
}

const freshTerms = (cfg) => ({ termMap: new Map(), glossed: new Set(), userKeep: parseNoTranslate(cfg.noTranslate) });

// 术语处理规则 + 当前已知术语清单，批量翻译、逐段降级、划词翻译共用同一套
function termSection(cfg, { termMap, glossed, userKeep }) {
  const mode = cfg.termMode || "keep";
  const parts = [];
  if (mode === "keep") {
    parts.push("术语处理规则（最高优先级）：人名、公司/机构/产品/项目/库/框架/模型名称、缩写、代码标识符，以及没有通行中文译名的专业术语，保留英文原文——不翻译、不音译、不加括注。有通行中文译名的概念性术语（如 machine learning→机器学习、neural network→神经网络、gradient boosting→梯度提升）要翻译；国家、城市、地区名称必须译成通行中文名（如 Seattle→西雅图、Jakarta→雅加达、Redmond→雷德蒙德）。其余内容译成简体中文，要通顺自然，避免无谓的中英文夹杂。");
    const keep = [...termMap.keys()].slice(0, TERMS_IN_PROMPT_LIMIT);
    if (keep.length) parts.push("已确定保持原文的术语：\n" + keep.map((k) => `- ${k}`).join("\n"));
  } else if (mode === "gloss") {
    parts.push("术语处理规则（最高优先级）：人名、公司/机构/产品名称、技术术语、行业行话、缩写首次出现时写成“中文译名（English Original）”，此后同一术语只写中文译名；代码标识符保持原样。地名、普通名词（如数据中心、区域）和日常词汇照常翻译，不要括注。");
    const first = [], done = [];
    for (const [src, dst] of termMap) (glossed.has(src) ? done : first).push(`'${src}': '${dst}'`);
    if (first.length) parts.push("以下术语尚未括注，首次出现时按“译名（原文）”写：\n" + first.slice(0, TERMS_IN_PROMPT_LIMIT).join("\n"));
    if (done.length) parts.push("以下术语已括注过，只写中文译名，不要再括注：\n" + done.slice(0, TERMS_IN_PROMPT_LIMIT).join("\n"));
  } else if (termMap.size) {
    parts.push(`必须遵守的术语（优先级最高，原文出现时一律采用给定译法）：\n${renderTerms(termMap)}`);
  }
  if (userKeep.length) {
    parts.push("用户指定永不翻译，以下词语无论如何保持原样（不翻译、不音译、不括注）：\n" + userKeep.map((k) => `- ${k}`).join("\n"));
  }
  return parts.join("\n\n");
}

async function callDeepSeek(text, cfg, terms = freshTerms(cfg)) {
  if (isMostlyCJK(text)) return text;
  const rules = termSection(cfg, terms);
  return callLLM([
    {
      role: "system",
      content: `你是母语为${TARGET}的专业译者。只输出译文，不要任何前缀、解释或标记。中文与英文、数字之间加一个半角空格。${rules ? "\n\n" + rules : ""}`
    },
    { role: "user", content: `翻译成${TARGET}：\n\n${text}` }
  ], cfg);
}

// 划词翻译：附带页面标题与选区所在段落，让模型结合语境
async function translateSelection(text, context, cfg) {
  if (isMostlyCJK(text)) return text;
  const ctx = [
    context.title ? `页面标题：${context.title}` : "",
    context.around ? `选区所在段落（仅供理解语境，不要翻译）：${context.around}` : ""
  ].filter(Boolean).join("\n");
  return callLLM([
    {
      role: "system",
      content: `你是母语为${TARGET}的专业译者。结合给定语境，把用户选中的文本译成${TARGET}，术语与指代要符合语境。只输出选中文本的译文，不要解释。\n\n${termSection(cfg, freshTerms(cfg))}\n\n${ctx}`
    },
    { role: "user", content: text }
  ], cfg);
}

// ========== 缓存（storage.session：浏览器关闭前有效，刷新页面不用重翻） ==========
function hashStr(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

async function cacheGet(key) {
  try {
    const r = await chrome.storage.session.get(key);
    return r[key] || null;
  } catch (_) { return null; }
}
async function cacheSet(key, val) {
  try { await chrome.storage.session.set({ [key]: val }); } catch (_) {}
}

// 术语策略和不翻译词表会改变译文，必须进缓存键，否则切换后读到旧译文
const transKey = (cfg, text) =>
  `t:${hashStr(`${cfg.model}|${cfg.termMode || "keep"}|${cfg.noTranslate || ""}|${text}`)}:${text.length}`;

async function transCacheGetMany(keys) {
  try { return await chrome.storage.session.get(keys); } catch (_) { return {}; }
}

// 写入译文缓存，按先进先出淘汰，最多保留 CACHE_MAX 条
async function transCacheSetMany(pairs) {
  const keys = Object.keys(pairs);
  if (!keys.length) return;
  try {
    const r = await chrome.storage.session.get("tc:idx");
    const idx = (r["tc:idx"] || []).filter((k) => !(k in pairs));
    idx.push(...keys);
    const evict = idx.length > CACHE_MAX ? idx.splice(0, idx.length - CACHE_MAX) : [];
    await chrome.storage.session.set({ ...pairs, "tc:idx": idx });
    if (evict.length) await chrome.storage.session.remove(evict);
  } catch (_) {}
}

// ========== 文档上下文：主题 / 风格 / 术语（替代云端摘要） ==========
function parseJsonLoose(raw) {
  const cleaned = raw.replace(/```(?:json)?/gi, "");
  const a = cleaned.indexOf("{");
  const b = cleaned.lastIndexOf("}");
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(cleaned.slice(a, b + 1)); } catch (_) { return null; }
}

async function buildDocContext(title, text, cfg) {
  const body = text.slice(0, DOC_TEXT_LIMIT);
  const mode = cfg.termMode || "keep";
  const key = "ctx:" + hashStr(`${mode}|${title}|${body}`);
  const hit = await cacheGet(key);
  if (hit) return hit;

  const THEME_STYLE = '"theme":"一句话主题与所属领域","style":"语气/文体/受众的翻译风格要求，不超过60字"';
  const termSpec = mode === "keep"
    ? [`{${THEME_STYLE},"terms":[{"src":"需要保留英文原文的专有名词或术语"}]}`,
       "术语只收：人名、公司/机构、产品/项目/库/框架/模型名、缩写、没有通行中文译名的专业术语；不收有通行中文译名的概念（如 machine learning、neural network）、普通词汇、整句，也不收国家、城市等地名；最多24条。"]
    : mode === "gloss"
    ? [`{${THEME_STYLE},"terms":[{"src":"英文原文","dst":"中文译名"}]}`,
       "术语只收：人名、公司/机构、产品/项目/库/框架名、技术术语与行业行话、缩写；不收地名（国家、城市、地区）、普通名词和日常词汇；最多24条。"]
    : [`{${THEME_STYLE},"terms":[{"src":"原文术语","dst":"建议译法","domain":"可选领域"}]}`,
       "术语只收：人名、机构、地名、作品名、缩写、领域专业术语、存在多种译法的专名；不收普通词汇和整句；最多20条。"];

  const prompt = [
    "你是资深翻译编辑。阅读下面文章，为后续逐段翻译准备上下文。",
    "只输出 JSON，不要其它文字：",
    ...termSpec,
    `目标语言：${TARGET}`,
    `标题：${title}`,
    `正文：\n${body}`
  ].join("\n");

  let ctx = { theme: "", style: "", terms: [] };
  try {
    const raw = await callLLM([{ role: "user", content: prompt }], cfg, { temperature: 0.1 });
    const j = parseJsonLoose(raw);
    if (j) {
      ctx = {
        theme: String(j.theme || "").slice(0, 200),
        style: String(j.style || "").slice(0, 120),
        terms: (Array.isArray(j.terms) ? j.terms : [])
          .filter((t) => t && t.src && (mode === "keep" || t.dst))
          // 保留原文模式下译名就是原文本身
          .map((t) => ({ src: String(t.src).trim(), dst: mode === "keep" ? String(t.src).trim() : String(t.dst).trim() }))
          .slice(0, 24)
      };
    }
  } catch (_) { /* 上下文提取失败不影响翻译，降级为空上下文 */ }

  await cacheSet(key, ctx);
  return ctx;
}

// ========== 批量翻译 ==========
function renderTerms(termMap) {
  const lines = [];
  for (const [src, dst] of termMap) {
    lines.push(`'${src}': '${dst}'`);
    if (lines.length >= TERMS_IN_PROMPT_LIMIT) break;
  }
  return lines.join("\n");
}

function buildBatchSystemPrompt(cfg, ctx, job) {
  const prevPairs = job.prevPairs;
  const mode = cfg.termMode || "keep";
  const parts = [
    `你是母语为${TARGET}的专业译者。逐条翻译，译文自然流畅，保持原意、语气和格式。`,
    "代码、占位符、不应翻译的内容保持原样。只输出译文，不加解释。中文与英文、数字之间加一个半角空格。"
  ];
  if (ctx.theme) parts.push(`文档主题：${ctx.theme}`);
  if (ctx.style) parts.push(`风格要求：${ctx.style}`);
  const rules = termSection(cfg, job);
  if (rules) parts.push(rules);
  if (prevPairs.length) {
    parts.push(
      "前文参考（仅用于理解指代与语气，不要重复翻译）：\n" +
      prevPairs.map((p) => `原文：${p.src}\n译文：${p.dst}`).join("\n---\n")
    );
  }
  parts.push(
    "输出格式：每条以 [[p0]]、[[p1]]…（与输入编号一致）单独占一行开头，后接该条译文。",
    ...(mode === "keep"
      ? ["全部译完后另起一行写 [[terms]]，列出本次新出现、且你保留了英文原文的专有名词/术语（不含上面已列出的）：",
         "每个术语写成 [[term]] 换行 英文原文，最多 12 个，没有则留空。最后一行写 [[end]]。"]
      : ["全部译完后另起一行写 [[terms]]，列出本次新出现、且后文可能译法不一致的专名/术语：",
         "每个术语写成 [[term]] 换行 原文 换行 译文，最多 12 个，没有则留空。最后一行写 [[end]]。"])
  );
  return parts.join("\n\n");
}

function buildBatchUserPrompt(items) {
  return items.map((it, i) => `[[p${i}]]\n${it.text}`).join("\n");
}

// 解析 [[pN]] 译文 与 [[terms]] 新术语
function parseBatchResponse(raw, mode = "translate") {
  let text = stripThink(raw).replace(/```/g, "");
  const termIdx = text.search(/\[\[terms\]\]/i);
  let main = termIdx >= 0 ? text.slice(0, termIdx) : text;
  const termPart = termIdx >= 0 ? text.slice(termIdx).replace(/\[\[terms\]\]/i, "") : "";
  main = main.replace(/\[\[end\]\]\s*$/i, "");

  const out = new Map();
  const re = /\[\[p(\d+)\]\]\s*([\s\S]*?)(?=\[\[p\d+\]\]|$)/gi;
  let m;
  while ((m = re.exec(main))) {
    const t = m[2].trim();
    if (t) out.set(Number(m[1]), t);
  }

  const newTerms = [];
  termPart.replace(/\[\[end\]\][\s\S]*$/i, "").split(/\[\[term\]\]/i).forEach((blk) => {
    const lines = blk.split("\n").map((s) => s.trim()).filter(Boolean);
    // 保留原文模式下每个术语只有一行（原文），译名即原文
    if (mode === "keep" ? lines.length >= 1 : lines.length >= 2) {
      newTerms.push({ src: lines[0], dst: mode === "keep" ? lines[0] : lines[1] });
    }
  });
  return { translations: out, newTerms };
}

function makeBatches(paragraphs) {
  const batches = [];
  let cur = [], chars = 0;
  paragraphs.forEach((text, index) => {
    if (cur.length && (cur.length >= BATCH_MAX_ITEMS || chars + text.length > BATCH_MAX_CHARS)) {
      batches.push(cur);
      cur = []; chars = 0;
    }
    cur.push({ index, text });
    chars += text.length;
  });
  if (cur.length) batches.push(cur);
  return batches;
}

// 处理页面送来的一块段落：先查缓存，没命中的再分批翻译；每批译完立即回传
async function processChunk(tabId, job, items) {
  const isLive = () => jobs.get(tabId) === job;
  await job.ready;
  if (!isLive()) return;
  const { cfg } = job;

  const keys = items.map((it) => transKey(cfg, it.text));
  const hits = await transCacheGetMany(keys);
  const cached = [];
  const todo = [];
  items.forEach((it, i) => {
    const h = hits[keys[i]];
    if (h) cached.push({ id: it.id, text: cfg.termMode === "gloss" ? polishGloss(h, job) : h, ok: true });
    else todo.push({ id: it.id, text: it.text, key: keys[i] });
  });
  if (cached.length && isLive()) sendToTab(tabId, { action: "page-batch-result", jobId: job.jobId, items: cached });
  if (!todo.length) return;

  // “读全文”提取主题/术语：整页只启动一次，各批不必死等。第一批最多等 CTX_WAIT_MS，
  // 超时就先用空上下文翻，提取完成后后面的批次自动带上
  if (cfg.contextMode && !job.ctxPromise) {
    job.ctxPromise = buildDocContext(job.title, job.docText || todo.map((t) => t.text).join("\n"), cfg).then((c) => {
      job.ctx = c;
      for (const t of c.terms) if (!job.termMap.has(t.src)) job.termMap.set(t.src, t.dst);
      return c;
    });
  }
  if (cfg.contextMode && !job.ctx) {
    await Promise.race([job.ctxPromise, new Promise((r) => setTimeout(r, CTX_WAIT_MS))]);
    if (!isLive()) return;
  }

  // 一块里的各批并发翻译（上限 MAX_PARALLEL），谁先译完谁先回传
  await Promise.all(makeBatches(todo.map((t) => t.text)).map((batch) => runBatch(batch)));

  async function runBatch(batch) {
    await acquire(job);
    try {
      if (!isLive()) return;
      const ctx = job.ctx || { theme: "", style: "", terms: [] };

      let translations = new Map();
      if (cfg.contextMode) {
        try {
          const raw = await callLLM([
            { role: "system", content: buildBatchSystemPrompt(cfg, ctx, job) },
            { role: "user", content: buildBatchUserPrompt(batch) }
          ], cfg);
          const parsed = parseBatchResponse(raw, cfg.termMode || "keep");
          translations = parsed.translations;
          for (const t of parsed.newTerms) {
            if (!job.termMap.has(t.src)) job.termMap.set(t.src, t.dst);
            if (cfg.termMode === "gloss") job.glossed.add(t.src); // 新术语已在本批首次括注
          }
        } catch (_) { /* 整批失败，交给下面逐段降级 */ }
      }

      // 降级：批处理缺失或解析失败的段落，逐段单独翻译，保证不丢译文（同样遵守术语策略）
      const out = [];
      const toCache = {};
      for (let i = 0; i < batch.length; i++) {
        const src = todo[batch[i].index];
        let text = translations.get(i);
        if (!text) {
          try { text = await callDeepSeek(src.text, cfg, job); } catch (_) { text = ""; }
        }
        if (text && cfg.termMode === "gloss") text = polishGloss(text, job);
        out.push({ id: src.id, text, ok: !!text });
        if (text) toCache[src.key] = text;
      }
      if (!isLive()) return;
      if (cfg.termMode === "gloss") {
        // 首次括注：本批原文里出现过的已知术语，视为已括注，后续批次只写中文
        const srcAll = batch.map((b) => b.text).join("\n").toLowerCase();
        for (const s of job.termMap.keys()) if (srcAll.includes(s.toLowerCase())) job.glossed.add(s);
      }
      sendToTab(tabId, { action: "page-batch-result", jobId: job.jobId, items: out, fallback: fallbackInUse(cfg) });
      await transCacheSetMany(toCache);

      job.prevPairs = batch.slice(-2).map((b, k, arr) => ({
        src: b.text.slice(0, 300),
        dst: (out[batch.length - arr.length + k].text || "").slice(0, 300)
      })).filter((p) => p.dst);
    } finally {
      release(job);
    }
  }
}

// 并发限流：同一任务同时最多 MAX_PARALLEL 个批次在请求模型
function acquire(job) {
  if (job.running < MAX_PARALLEL) {
    job.running++;
    return Promise.resolve();
  }
  return new Promise((resolve) => job.waiters.push(resolve));
}
function release(job) {
  const next = job.waiters.shift();
  if (next) next(); // 名额直接转给排队的下一个
  else job.running--;
}
