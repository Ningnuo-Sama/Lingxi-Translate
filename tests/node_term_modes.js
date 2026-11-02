// 术语处理三档实测：MODE=keep|gloss|translate，NOTRANS=逗号分隔的不翻译词
const fs = require("fs");
const vm = require("vm");
const SRC = "D:/GitHub/DeepSeek-Translator-Extension/background.js";
const MODE = process.env.MODE || "keep";
const NOTRANS = (process.env.NOTRANS || "").split(",").join("\n");

const store = { termMode: MODE, noTranslate: NOTRANS }; const session = {};
const sent = []; let msgListener;
const pick = (obj, k) => { const r = {}; (Array.isArray(k) ? k : [k]).forEach((x) => { if (x in obj) r[x] = obj[x]; }); return r; };
const chrome = {
  runtime: { onInstalled: { addListener() {} }, onMessage: { addListener(fn) { msgListener = fn; } }, lastError: null, getPlatformInfo(cb) { cb && cb({}); } },
  commands: { onCommand: { addListener() {} } },
  tabs: { query() {}, sendMessage(t, msg, cb) { sent.push(msg); if (cb) cb(); } },
  storage: {
    local: { get(d, cb) { cb(Object.assign({}, d, store)); }, set(o) { Object.assign(store, o); } },
    session: { async get(k) { return pick(session, k); }, async set(o) { Object.assign(session, o); }, async remove(k) { (Array.isArray(k) ? k : [k]).forEach((x) => delete session[x]); } }
  }
};
const ctx = vm.createContext({ chrome, fetch, AbortController, setTimeout, clearTimeout, setInterval, clearInterval, console, Map, Set, JSON, Math, Date, Number, String, Array, Object, Error, RegExp, Promise });
vm.runInContext(fs.readFileSync(SRC, "utf8"), ctx);

const P = [
  "Satya Nadella, the chief executive of Microsoft, announced that the company would expand its Azure cloud platform across Southeast Asia over the next two years.",
  "He said the move reflects growing demand for generative AI services built on the Transformer architecture, and that Azure OpenAI would be a central part of the rollout.",
  "Analysts at Gartner noted that Nadella has repeatedly stressed responsible AI. Gartner expects Copilot adoption to double.",
  "The Redmond-based company also confirmed that it will open three new data centers in Jakarta and Seattle.",
  "Later, Copilot engineers demonstrated how Kubernetes and Docker containers are scheduled on the new Azure regions, according to Gartner."
];
const SETML = process.env.SET === "ml";
if (SETML) {
  P.length = 0;
  P.push(
    "TensorFlow - An open source Machine Learning platform with a comprehensive tool ecosystem.",
    "PyTorch - An open source Deep Learning framework offering flexible dynamic computation graphs.",
    "Scikit-learn - A Python library for Machine Learning including classification, regression and clustering.",
    "Keras - A high-level neural networks API, written in Python, running on top of TensorFlow or Theano.",
    "OpenAI Gym - A toolkit for developing and comparing reinforcement learning algorithms.",
    "XGBoost - A scalable and efficient gradient boosting framework.",
    "LightGBM - A fast, distributed, high performance gradient boosting framework.",
    "CatBoost - A gradient boosting library that handles categorical features automatically.",
    "Dask-ML - Scalable machine learning with Dask, integrated for parallel computing.",
    "MLflow - An open source platform to manage the end-to-end machine learning lifecycle."
  );
}
const SENDER = { tab: { id: 7 } };
const send = (m) => msgListener(m, SENDER, () => {});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = () => { const m = new Map(); sent.filter((x) => x.action === "page-batch-result").forEach((x) => x.items.forEach((i) => m.set(i.id, i))); return m; };

(async () => {
  send({ action: "translate-page", jobId: "J", title: "Microsoft expands Azure in Southeast Asia", docText: P.join("\n") });
  await sleep(50);
  const cut = SETML ? 5 : 3;
  send({ action: "translate-chunk", jobId: "J", items: P.slice(0, cut).map((text, i) => ({ id: i + 1, text })) });
  send({ action: "translate-chunk", jobId: "J", items: P.slice(cut).map((text, i) => ({ id: i + cut + 1, text })) });
  const t0 = Date.now();
  while (results().size < P.length && Date.now() - t0 < 150000) await sleep(300);
  const r = results();
  console.log(`===== MODE=${MODE} NOTRANS=${process.env.NOTRANS || "-"}  (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  for (let i = 1; i <= P.length; i++) console.log(`#${i} ${r.get(i)?.ok ? "" : "[FAIL] "}${r.get(i)?.text}`);
  const all = Array.from({ length: P.length }, (_, k) => k + 1).map((i) => r.get(i)?.text || "").join("\n");
  const has = (s) => all.includes(s);
  const count = (s) => (all.match(new RegExp(s.replace(/[()]/g, "\\$&"), "g")) || []).length;
  console.log("-- checks");
  console.log("Azure kept:", has("Azure"), "| Copilot kept:", has("Copilot"), "| Transformer kept:", has("Transformer"), "| Kubernetes kept:", has("Kubernetes"));
  console.log("Gartner kept:", has("Gartner"), "| 高德纳 appears:", has("高德纳"), "| Satya Nadella kept:", has("Satya Nadella"), "| 纳德拉 appears:", has("纳德拉"));
  console.log("Seattle→西雅图:", has("西雅图"), "| Redmond kept:", has("Redmond"), "| 雷德蒙德 appears:", has("雷德蒙德"));
  console.log("Gartner括注次数 '（Gartner）':", count("（Gartner）"), "| 'Gartner' 总出现:", count("Gartner"));
  process.exit(0);
})();
