"""真实 Chromium：长页面 + 模拟后台任务丢失 / 消息被吞，验证“翻译中…”不会卡死；并测预取与首屏速度"""
import http.server, json, shutil, socketserver, threading, time
from pathlib import Path
from playwright.sync_api import sync_playwright

EXT = str(Path(__file__).resolve().parent.parent)
CHROME = r"C:\Users\1\.cloakbrowser\chromium-146.0.7680.177.5\chrome.exe"
import tempfile
SCR = Path(tempfile.gettempdir()) / "ds-translator-tests"  # 临时产物（截图、结果 json、测试页）都放这里
SCR.mkdir(exist_ok=True)
WEB = SCR / "web4"
PORT = 18768

secs = ["General AI", "Machine Learning", "Deep Learning", "NLP", "Computer Vision", "Reinforcement Learning", "AI Ethics", "Books"]
body = ""
n = 0
for s in secs:
    items = ""
    for i in range(20):
        n += 1
        items += f'<li><a href="#p{n}">Project{n}</a> - A community maintained toolkit number {n} for building reliable {s.lower()} pipelines and tracking experiments in production.</li>'
    body += f"<h2>{s}</h2><ul>{items}</ul>"
html = f"""<!doctype html><html><head><meta charset="utf-8"><title>awesome-ai-tools (long)</title>
<style>body{{background:#0d1117;color:#c9d1d9;font:16px/1.5 -apple-system,Segoe UI,Arial,sans-serif;max-width:900px;margin:0 auto;padding:24px}}
h2{{border-bottom:1px solid #30363d;padding-bottom:.3em;margin:24px 0 16px}}ul{{padding-left:2em;margin:0 0 16px}}li{{margin:.25em 0}}a{{color:#58a6ff;text-decoration:none}}</style></head>
<body>{body}</body></html>"""
WEB.mkdir(exist_ok=True)
(WEB / "long.html").write_text(html, encoding="utf-8")


class Quiet(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k):
        super().__init__(*a, directory=str(WEB), **k)
    def log_message(self, *a):
        pass


socketserver.ThreadingTCPServer.daemon_threads = True  # 多线程：Chromium 预开的空闲连接不会把单线程服务器堵住
socketserver.ThreadingTCPServer.allow_reuse_address = True
httpd = socketserver.ThreadingTCPServer(("127.0.0.1", PORT), Quiet)
threading.Thread(target=httpd.serve_forever, daemon=True).start()
prof = SCR / "real_profile_idle"
shutil.rmtree(prof, ignore_errors=True)
R = {}

with sync_playwright() as pw:
    ctx = pw.chromium.launch_persistent_context(
        str(prof), executable_path=CHROME, headless=False, ignore_default_args=["--disable-extensions"],
        args=[f"--disable-extensions-except={EXT}", f"--load-extension={EXT}", "--headless=new", "--no-proxy-server"],
        viewport={"width": 1100, "height": 900})
    try:
        sw = ctx.service_workers[0] if ctx.service_workers else ctx.wait_for_event("serviceworker", timeout=20000)
        page = ctx.new_page()
        errs = []
        page.on("pageerror", lambda e: errs.append(str(e)))
        page.goto(f"http://127.0.0.1:{PORT}/long.html")
        page.wait_for_load_state("load")
        time.sleep(1.0)
        total_li = page.evaluate("document.querySelectorAll('li').length")

        def counts():
            return page.evaluate("""() => ({n: document.querySelectorAll('.deepseek-dual-target').length,
                p: document.querySelectorAll('.deepseek-dual-pending').length,
                f: document.querySelectorAll('.deepseek-dual-failed').length,
                ok: [...document.querySelectorAll('.deepseek-dual-target')].filter(n => !n.classList.contains('deepseek-dual-pending') && !n.classList.contains('deepseek-dual-failed')).length})""")

        def wait_settled(limit):
            t0 = time.time()
            while time.time() - t0 < limit:
                time.sleep(0.4)
                c = counts()
                if c["n"] > 0 and c["p"] == 0:
                    return round(time.time() - t0, 1), c
            return None, counts()

        # --- 首屏速度 + 预取 ---
        t0 = time.time()
        tab = sw.evaluate("() => new Promise(r => chrome.tabs.query({}, ts => r(ts.find(t => t.url && t.url.includes('long.html')).id)))")
        sw.evaluate("(id) => new Promise(r => chrome.tabs.sendMessage(id, {action:'toggle-page-translate'}, r))", tab)
        first = None
        for _ in range(200):
            time.sleep(0.2)
            c = counts()
            if first is None and c["ok"] > 0:
                first = round(time.time() - t0, 1)
            if c["n"] > 0 and c["p"] == 0:
                break
        R["first_screen"] = {"first_result_s": first, "all_settled_s": round(time.time() - t0, 1), **c, "li_total": total_li,
                             "prefetched_beyond_viewport": c["n"] > 25}

        # --- 场景 1：后台任务丢失（等价于后台脚本被回收）---
        sw.evaluate("() => { jobs.clear(); return jobs.size }")
        R["scenario1_jobs_cleared"] = True
        for _ in range(4):
            page.mouse.wheel(0, 1500)
            time.sleep(0.6)
        secs1, c1 = wait_settled(90)
        R["scenario1_after_job_lost"] = {"settled_in_s": secs1, **c1}

        # --- 场景 2：消息被吞（后台收到分块但一直没结果），35 秒后页面端应自动重发 ---
        sw.evaluate("() => { globalThis.__origProcess = processChunk; processChunk = async () => {}; }")
        n_before = counts()["n"]
        for _ in range(4):
            page.mouse.wheel(0, 1500)
            time.sleep(0.6)
        time.sleep(3)
        stuck = counts()
        R["scenario2_stuck_now"] = stuck
        sw.evaluate("() => { processChunk = globalThis.__origProcess; }")  # 后台“恢复”，但已经发出去的请求不会再来
        t1 = time.time()
        secs2, c2 = wait_settled(120)
        R["scenario2_recovered"] = {"settled_in_s": secs2, "waited_s": round(time.time() - t1, 1), **c2}
        page.screenshot(path=str(SCR / "idle_final.png"))
        R["page_errors"] = errs
    finally:
        ctx.close()
httpd.shutdown()
(SCR / "idle_result.json").write_text(json.dumps(R, ensure_ascii=False, indent=1), encoding="utf-8")
print("DONE")
