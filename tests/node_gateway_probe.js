// 并发上限能开多大 + “读全文”一步（关思考后）要多久
const fs = require("fs");
const vm = require("vm");
const SRC = "D:/GitHub/DeepSeek-Translator-Extension/background.js";
const chrome = {
  runtime: { onInstalled: { addListener() {} }, onMessage: { addListener() {} }, lastError: null },
  commands: { onCommand: { addListener() {} } }, tabs: {},
  storage: { local: { get(d, cb) { cb(d); }, set() {} }, session: { async get() { return {}; }, async set() {}, async remove() {} } }
};
const ctx = vm.createContext({ chrome, fetch, AbortController, setTimeout, clearTimeout, console, Map, Set, JSON, Math, Date, Number, String, Array, Object, Error, RegExp, Promise });
vm.runInContext(fs.readFileSync(SRC, "utf8") + "\n;this.__t = { buildBatchSystemPrompt, buildBatchUserPrompt, buildDocContext, DEFAULT_CONFIG };", ctx);
const T = ctx.__t;
const cfg = Object.assign({}, T.DEFAULT_CONFIG);
const job = { termMap: new Map(), glossed: new Set(), glossSeen: new Set(), userKeep: [], prevPairs: [], cfg };
const sys = T.buildBatchSystemPrompt(cfg, { theme: "", style: "", terms: [] }, job);
const mk = (tag) => Array.from({ length: 8 }, (_, i) => ({ text: `Project${tag}-${i} - A community maintained toolkit for building reliable data pipelines and tracking experiments number ${tag}${i}.` }));
async function one(tag) {
  const t0 = Date.now();
  const r = await fetch(cfg.apiUrl, { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer admin" },
    body: JSON.stringify({ model: cfg.model, thinking: { type: "disabled" }, temperature: 0.3, messages: [{ role: "system", content: sys }, { role: "user", content: T.buildBatchUserPrompt(mk(tag)) }] }) });
  await r.json();
  return { ms: Date.now() - t0, status: r.status };
}
(async () => {
  console.log("== 并发批次（每批 8 条，关思考）==");
  for (const n of [1, 4, 8, 12, 16]) {
    const t0 = Date.now();
    const rs = await Promise.all(Array.from({ length: n }, (_, k) => one(`c${n}-${k}`)));
    const bad = rs.filter((r) => r.status !== 200).length;
    console.log(`并发 ${String(n).padStart(2)}: 总耗时 ${Date.now() - t0} ms | 单个最慢 ${Math.max(...rs.map((r) => r.ms))} ms | 非200 ${bad}`);
  }
  console.log("\n== “读全文”提取（关思考）==");
  const doc = Array.from({ length: 40 }, (_, i) => `Project${i} - A community maintained toolkit for building reliable data pipelines and tracking experiments number ${i}.`).join("\n");
  for (let i = 0; i < 3; i++) {
    const t0 = Date.now();
    await T.buildDocContext("awesome ai tools " + i, doc + i, cfg);
    console.log(`buildDocContext 第${i + 1}次: ${Date.now() - t0} ms`);
  }
  process.exit(0);
})();
