"""真实 Chromium 146 加载扩展：GitHub 深色 awesome 列表页，对比“关闭思考”开关的速度，并截取各种译文样式。"""
import http.server, json, shutil, socketserver, sys, threading, time
from pathlib import Path
from playwright.sync_api import sync_playwright

EXT = str(Path(__file__).resolve().parent.parent)
CHROME = r"C:\Users\1\.cloakbrowser\chromium-146.0.7680.177.5\chrome.exe"
import tempfile
SCR = Path(tempfile.gettempdir()) / "ds-translator-tests"  # 临时产物（截图、结果 json、测试页）都放这里
SCR.mkdir(exist_ok=True)
WEB = SCR / "web3"
PORT = 18767

general = [
    ("TensorFlow", "An open source Machine Learning platform with a comprehensive tool ecosystem."),
    ("PyTorch", "An open source Deep Learning framework offering flexible dynamic computation graphs."),
    ("Scikit-learn", "A Python library for Machine Learning including classification, regression and clustering."),
    ("Keras", "A high-level neural networks API, written in Python, running on top of TensorFlow or Theano."),
    ("OpenAI Gym", "A toolkit for developing and comparing reinforcement learning algorithms."),
]
ml = [
    ("XGBoost", "A scalable and efficient gradient boosting framework."),
    ("LightGBM", "A fast, distributed, high performance gradient boosting framework."),
    ("CatBoost", "A gradient boosting library that handles categorical features automatically."),
    ("Dask-ML", "Scalable machine learning with Dask, integrated for parallel computing."),
    ("MLflow", "An open source platform to manage the end-to-end machine learning lifecycle."),
    ("Optuna", "A hyperparameter optimization framework that automates the search for good settings."),
    ("Ray", "A unified framework for scaling AI and Python applications across a cluster."),
]
more = [(f"Tool{i}", f"A community maintained project number {i} that helps teams with data pipelines and experiment tracking.") for i in range(12)]
li = lambda xs: "".join(f'<li><a href="#{n}">{n}</a> - {d}</li>' for n, d in xs)
html = f"""<!doctype html><html><head><meta charset="utf-8"><title>awesome-ai-tools</title>
<style>
body{{background:#0d1117;color:#c9d1d9;font:16px/1.5 -apple-system,Segoe UI,Helvetica,Arial,sans-serif;max-width:900px;margin:0 auto;padding:24px}}
h2{{font-size:1.5em;border-bottom:1px solid #30363d;padding-bottom:.3em;margin:24px 0 16px}}
h3{{font-size:1.25em;margin:24px 0 16px}}
ul{{padding-left:2em;margin:0 0 16px}} li{{margin:.25em 0}} a{{color:#58a6ff;text-decoration:none}}
p{{margin:0 0 16px}} table{{border-collapse:collapse}} td,th{{border:1px solid #30363d;padding:6px 13px}}
</style></head><body>
<h2>General AI</h2><ul>{li(general)}</ul>
<h3>Machine Learning</h3><ul>{li(ml)}</ul>
<p>This curated list collects open source projects that make it easier to build, train and ship machine learning systems in production environments.</p>
<table><tr><th>Project</th><th>Description</th></tr>
<tr><td>Hugging Face Transformers</td><td>State of the art pretrained models for natural language processing and vision tasks.</td></tr>
<tr><td>LangChain</td><td>A framework for building applications powered by large language models.</td></tr></table>
<h3>More tools</h3><ul>{li(more)}</ul>
</body></html>"""
WEB.mkdir(exist_ok=True)
(WEB / "awesome.html").write_text(html, encoding="utf-8")


class Quiet(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k):
        super().__init__(*a, directory=str(WEB), **k)
    def log_message(self, *a):
        pass


socketserver.ThreadingTCPServer.daemon_threads = True  # 多线程：Chromium 预开的空闲连接不会把单线程服务器堵住
socketserver.ThreadingTCPServer.allow_reuse_address = True
httpd = socketserver.ThreadingTCPServer(("127.0.0.1", PORT), Quiet)
threading.Thread(target=httpd.serve_forever, daemon=True).start()
R = {}


def run(label, set_cfg, shots):
    prof = SCR / f"real_profile_{label}"
    shutil.rmtree(prof, ignore_errors=True)
    out = {}
    with sync_playwright() as pw:
        ctx = pw.chromium.launch_persistent_context(
            str(prof), executable_path=CHROME, headless=False, ignore_default_args=["--disable-extensions"],
            args=[f"--disable-extensions-except={EXT}", f"--load-extension={EXT}", "--headless=new", "--no-proxy-server"],
            viewport={"width": 1100, "height": 900})
        try:
            sw = ctx.service_workers[0] if ctx.service_workers else ctx.wait_for_event("serviceworker", timeout=20000)
            if set_cfg:
                sw.evaluate("(c) => new Promise(r => chrome.storage.local.set(c, r))", set_cfg)
            page = ctx.new_page()
            errs = []
            page.on("pageerror", lambda e: errs.append(str(e)))
            page.goto(f"http://127.0.0.1:{PORT}/awesome.html")
            page.wait_for_load_state("load")
            time.sleep(1.0)
            tab_id = sw.evaluate("() => new Promise(r => chrome.tabs.query({}, ts => r(ts.find(t => t.url && t.url.includes('awesome.html')).id)))")
            t0 = time.time()
            sw.evaluate("(id) => new Promise(r => chrome.tabs.sendMessage(id, {action:'toggle-page-translate'}, r))", tab_id)
            first = None
            for _ in range(240):
                time.sleep(0.25)
                c = page.evaluate("""() => ({n: document.querySelectorAll('.deepseek-dual-target').length,
                    p: document.querySelectorAll('.deepseek-dual-pending').length,
                    f: document.querySelectorAll('.deepseek-dual-failed').length})""")
                if first is None and c["n"] > c["p"]:
                    first = round(time.time() - t0, 1)
                if c["n"] > 0 and c["p"] == 0:
                    break
            out["first_result_s"] = first
            out["all_done_s"] = round(time.time() - t0, 1)
            out["counts"] = c
            out["errors"] = errs
            out["texts"] = page.evaluate("""() => [...document.querySelectorAll('.deepseek-dual-target')].slice(0,14).map(n => n.innerText)""")
            # 译文与原文的间距/字号是否贴合：取第一条列表项
            out["look"] = page.evaluate("""() => {
              const li = document.querySelector('li'); const t = li.nextElementSibling;
              const a = li.getBoundingClientRect(), b = t.getBoundingClientRect();
              const cs = getComputedStyle(t), co = getComputedStyle(li);
              return {gap_px: Math.round(b.top - a.bottom), font_same: cs.fontSize === co.fontSize, color_same: cs.color === co.color,
                      bg: cs.backgroundColor, border_left: cs.borderLeftWidth, h3_same: (() => { const h = document.querySelector('h3'); const th = h.nextElementSibling; return getComputedStyle(th).fontSize === getComputedStyle(h).fontSize; })() }}""")
            for name, style in shots:
                sw.evaluate("(s) => new Promise(r => chrome.storage.local.set({transStyle: s}, r))", style)
                time.sleep(0.6)
                page.screenshot(path=str(SCR / f"style_{label}_{name}.png"), clip={"x": 0, "y": 0, "width": 1100, "height": 760})
        finally:
            ctx.close()
    return out


R["A_noThinking_on_default"] = run("A", None, [("plain", "plain"), ("muted", "muted"), ("underline", "underline"), ("bar", "bar")])
R["B_noThinking_off"] = run("B", {"noThinking": False}, [])
httpd.shutdown()
(SCR / "style_result.json").write_text(json.dumps(R, ensure_ascii=False, indent=1), encoding="utf-8")
print("DONE")
