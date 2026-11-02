// 复现：MV3 后台脚本空闲被回收 → 内存里的任务表丢失 → 之后到的分块被丢弃
const fs = require("fs");
const vm = require("vm");
const SRC = "D:/GitHub/DeepSeek-Translator-Extension/background.js";
const session = {}, sent = [];
let msgListener;
const pick = (o, k) => { const r = {}; (Array.isArray(k) ? k : [k]).forEach((x) => { if (x in o) r[x] = o[x]; }); return r; };
const chrome = {
  runtime: { onInstalled: { addListener() {} }, onMessage: { addListener(fn) { msgListener = fn; } }, lastError: null, getPlatformInfo(cb) { cb && cb({}); } },
  commands: { onCommand: { addListener() {} } },
  tabs: { query() {}, sendMessage(t, m, cb) { sent.push(m); if (cb) cb(); } },
  storage: {
    local: { get(d, cb) { cb(Object.assign({}, d)); }, set() {} },
    session: { async get(k) { return pick(session, k); }, async set(o) { Object.assign(session, o); }, async remove(k) { (Array.isArray(k) ? k : [k]).forEach((x) => delete session[x]); } }
  }
};
const ctx = vm.createContext({ chrome, fetch, AbortController, setTimeout, clearTimeout, setInterval, clearInterval, console, Map, Set, JSON, Math, Date, Number, String, Array, Object, Error, RegExp, Promise });
vm.runInContext(fs.readFileSync(SRC, "utf8"), ctx);
const SENDER = { tab: { id: 7 } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const send = (m) => msgListener(m, SENDER, () => {});
const results = () => { const m = new Map(); sent.filter((x) => x.action === "page-batch-result").forEach((x) => x.items.forEach((i) => m.set(i.id, i))); return m; };

const mk = (tag, n) => Array.from({ length: n }, (_, i) => `Project${tag}${i} - A community maintained toolkit number ${tag}${i} for building reliable data pipelines and tracking experiments.`);
const TITLE = "awesome ai tools", DOC = mk("D", 12).join("\n");

(async () => {
  // 第一块：正常
  send({ action: "translate-page", jobId: "J", title: TITLE, docText: DOC });
  await sleep(50);
  const A = mk("A", 6);
  send({ action: "translate-chunk", jobId: "J", title: TITLE, docText: DOC, items: A.map((text, i) => ({ id: i + 1, text })) });
  let t0 = Date.now();
  while (results().size < 6 && Date.now() - t0 < 60000) await sleep(200);
  console.log(`第一块: 收到 ${results().size}/6`);

  // 模拟后台脚本被回收：任务表清空（真实情况是整个进程重启，内存全部丢失）
  vm.runInContext("jobs.clear()", ctx);
  console.log("—— 模拟后台脚本被回收（内存里的任务丢失）——");

  // 用户继续往下滚：第二块
  const B = mk("B", 6);
  send({ action: "translate-chunk", jobId: "J", title: TITLE, docText: DOC, items: B.map((text, i) => ({ id: 100 + i, text })) });
  t0 = Date.now();
  while ([...results().keys()].filter((k) => k >= 100).length < 6 && Date.now() - t0 < 25000) await sleep(300);
  const got = [...results().keys()].filter((k) => k >= 100).length;
  console.log(`第二块: 25 秒内收到 ${got}/6 ${got === 6 ? "（正常，已能自愈）" : "（被丢弃 —— 页面上会一直显示“翻译中…”）"}`);
  process.exit(0);
})();
