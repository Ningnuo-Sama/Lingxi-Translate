// 备用模型自动切换：主模型用一个网关里不存在的模型（返回 503）来模拟“账号冷却/不可用”
const fs = require("fs");
const vm = require("vm");
const SRC = "D:/GitHub/DeepSeek-Translator-Extension/background.js";
const BAD = "cn:no-such-model", GOOD = "cn:deepseek-v4.1-flash";
const store = { model: BAD, fallbackModel: GOOD };
const session = {}, sent = [], log = [];
let msgListener;
const pick = (o, k) => { const r = {}; (Array.isArray(k) ? k : [k]).forEach((x) => { if (x in o) r[x] = o[x]; }); return r; };
const chrome = {
  runtime: { onInstalled: { addListener() {} }, onMessage: { addListener(fn) { msgListener = fn; } }, lastError: null, getPlatformInfo(cb) { cb && cb({}); } },
  commands: { onCommand: { addListener() {} } },
  tabs: { query() {}, sendMessage(t, m, cb) { sent.push(m); if (cb) cb(); } },
  storage: {
    local: { get(d, cb) { cb(Object.assign({}, d, store)); }, set(o) { Object.assign(store, o); } },
    session: { async get(k) { return pick(session, k); }, async set(o) { Object.assign(session, o); }, async remove(k) { (Array.isArray(k) ? k : [k]).forEach((x) => delete session[x]); } }
  }
};
const loggingFetch = async (url, opt) => {
  const model = JSON.parse(opt.body).model;
  const t0 = Date.now();
  const r = await fetch(url, opt);
  log.push({ model, status: r.status, ms: Date.now() - t0 });
  return r;
};
const ctx = vm.createContext({ chrome, fetch: loggingFetch, AbortController, setTimeout, clearTimeout, setInterval, clearInterval, console, Map, Set, JSON, Math, Date, Number, String, Array, Object, Error, RegExp, Promise });
vm.runInContext(fs.readFileSync(SRC, "utf8"), ctx);
const SENDER = { tab: { id: 7 } };
const send = (m) => msgListener(m, SENDER, () => {});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = () => { const m = new Map(); sent.filter((x) => x.action === "page-batch-result").forEach((x) => x.items.forEach((i) => m.set(i.id, i))); return m; };
const calls = (model) => log.filter((l) => l.model === model).length;

const A = [
  "TensorFlow - An open source Machine Learning platform with a comprehensive tool ecosystem.",
  "PyTorch - An open source Deep Learning framework offering flexible dynamic computation graphs.",
  "Keras - A high-level neural networks API, written in Python, running on top of TensorFlow.",
  "XGBoost - A scalable and efficient gradient boosting framework for tabular data problems.",
  "MLflow - An open source platform to manage the end-to-end machine learning lifecycle."
];
const B = [
  "Optuna - A hyperparameter optimization framework that automates the search for good settings.",
  "Ray - A unified framework for scaling AI and Python applications across a cluster of machines.",
  "Dask-ML - Scalable machine learning with Dask, integrated for parallel computing workloads."
];
const C = ["Polars - A fast dataframe library implemented in Rust with a lazy query engine inside."];

(async () => {
  // 阶段 1：主模型坏的，应自动换备用并全部译完
  send({ action: "translate-page", jobId: "J", title: "AI tools", docText: A.join("\n") });
  await sleep(50);
  let t0 = Date.now();
  send({ action: "translate-chunk", jobId: "J", items: A.map((text, i) => ({ id: i + 1, text })) });
  while (results().size < A.length && Date.now() - t0 < 120000) await sleep(200);
  const r1 = results();
  console.log(`[阶段1 主模型故障] 译完 ${[...r1.values()].filter((x) => x.ok).length}/${A.length} 条，用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log("  示例:", r1.get(1)?.text, "|", r1.get(5)?.text);
  console.log(`  请求记录: 主模型(坏) ${calls(BAD)} 次，备用 ${calls(GOOD)} 次`);
  const notice1 = sent.filter((x) => x.action === "page-batch-result").map((x) => x.fallback);
  console.log("  回传里的备用提示:", JSON.stringify([...new Set(notice1)]));

  // 阶段 2：断路器已打开，新的一块不应再请求主模型
  const badBefore = calls(BAD);
  t0 = Date.now();
  send({ action: "translate-chunk", jobId: "J", items: B.map((text, i) => ({ id: 100 + i, text })) });
  while ([...results().keys()].filter((k) => k >= 100).length < B.length && Date.now() - t0 < 120000) await sleep(200);
  console.log(`[阶段2 冷却中] 新一块 ${B.length} 条，用时 ${((Date.now() - t0) / 1000).toFixed(1)}s，期间请求主模型 ${calls(BAD) - badBefore} 次（期望 0）`);

  // 阶段 3：模拟冷却结束，应再试一次主模型（仍然失败则继续走备用）
  const brk = vm.runInContext("breakers", ctx);
  for (const b of brk.values()) b.until = 0;
  const badBefore3 = calls(BAD);
  t0 = Date.now();
  send({ action: "translate-chunk", jobId: "J", items: C.map((text, i) => ({ id: 200 + i, text })) });
  while (!results().has(200) && Date.now() - t0 < 120000) await sleep(200);
  console.log(`[阶段3 冷却结束] 再试主模型 ${calls(BAD) - badBefore3} 次，最终 ok=${results().get(200)?.ok}: ${results().get(200)?.text}`);

  // 阶段 4：没配备用模型时行为不变（对照）
  store.fallbackModel = "";
  const brk2 = vm.runInContext("breakers", ctx); brk2.clear();
  send({ action: "translate-page", jobId: "K", title: "x", docText: "x" });
  await sleep(50);
  t0 = Date.now();
  send({ action: "translate-chunk", jobId: "K", items: [{ id: 300, text: "Spark - A unified engine for large scale data analytics on clusters." }] });
  while (!results().has(300) && Date.now() - t0 < 120000) await sleep(300);
  console.log(`[阶段4 不配备用] ok=${results().get(300)?.ok}（期望 false：主模型坏、没有备用），用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  process.exit(0);
})();
