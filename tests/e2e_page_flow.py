"""在真实 Chromium 146 里加载扩展，跑整页翻译 / 懒翻译 / 动态页面 / 术语保留 / 弹窗获取模型。
扩展、后台脚本、内容脚本都是真实运行，模型是本地 127.0.0.1:7863 的真实服务。"""
import http.server, json, os, re, shutil, socketserver, sys, threading, time
from pathlib import Path
from playwright.sync_api import sync_playwright

EXT = str(Path(__file__).resolve().parent.parent)
CHROME = r"C:\Users\1\.cloakbrowser\chromium-146.0.7680.177.5\chrome.exe"
import tempfile
SCR = Path(tempfile.gettempdir()) / "ds-translator-tests"  # 临时产物（截图、结果 json、测试页）都放这里
SCR.mkdir(exist_ok=True)
WEB = SCR / "web2"
PROFILE = SCR / "real_profile"
PORT = 18766

subjects = ["Microsoft", "Azure", "Copilot", "Kubernetes", "Gartner", "Satya Nadella", "Seattle", "Docker"]
paras = []
for i in range(26):
    s = subjects[i % len(subjects)]
    t = subjects[(i * 3 + 1) % len(subjects)]
    paras.append(
        f"Paragraph {i}: {s} announced a new roadmap this week, and analysts say the plan depends heavily on {t}. "
        f"The company expects measurable gains in reliability and cost across its data centers by the end of the year, "
        f"although several engineers warned that the schedule is aggressive."
    )
paras[3] = paras[3].replace("a new roadmap", 'a <a href="#roadmap">new roadmap</a>')

html = f"""<!doctype html><html><head><meta charset="utf-8"><title>Cloud platform roadmap: what changed this quarter</title>
<style>body{{font:16px/1.6 sans-serif;max-width:760px;margin:0 auto;padding:20px}}p{{margin:0 0 18px}}nav,footer{{color:#888}}</style></head><body>
<nav><p>Navigation paragraph that is long enough to be translated but lives inside nav so it should be skipped entirely.</p></nav>
<h1>Cloud platform roadmap: what changed this quarter</h1>
<p id="lead">{paras[0]}</p>
<div id="divleaf">This leaf div block is plain text without any block children and it should still be picked up.</div>
<p>这是一段已经是中文的段落，应该被自动跳过而不是发送去翻译，因为它本来就是中文。</p>
<pre>preformatted code block must never be collected even though it is definitely long enough to qualify</pre>
<ul><li>First list item explaining the migration plan in reasonable detail for the readers here.</li><li>Second list item explaining the rollback plan in reasonable detail for the readers here.</li></ul>
<blockquote>Quoted analyst remark about reliability that should be translated as its own block of text.</blockquote>
<table id="tbl"><thead><tr><th>Service</th><th>Provider</th><th>Notes</th></tr></thead><tbody>
<tr><td>Azure Kubernetes Service</td><td>Microsoft</td><td>Managed control plane with automatic upgrades and scaling</td></tr>
<tr><td>Google Container Registry</td><td>Google</td><td>Stores and serves container images across regions</td></tr>
<tr><td>Amazon Elastic Container Registry</td><td>Amazon</td><td>Private registry tightly integrated with the compute layer</td></tr>
</tbody></table>
{''.join(f'<p>{p}</p>' for p in paras[1:])}
<div id="more"></div><button id="loadmore" onclick="setTimeout(()=>{{const d=document.getElementById('more');for(let k=0;k<3;k++){{const p=document.createElement('p');p.id='dyn'+k;p.textContent='Dynamically loaded paragraph '+k+': Azure and Kubernetes were mentioned again after the user clicked the load more button.';d.appendChild(p)}}}},300)">Load more</button>
<footer><p>Footer paragraph that is long enough to be translated but lives inside footer and should be skipped.</p></footer>
</body></html>"""
WEB.mkdir(exist_ok=True)
(WEB / "article.html").write_text(html, encoding="utf-8")


class Quiet(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k):
        super().__init__(*a, directory=str(WEB), **k)
    def log_message(self, *a):
        pass


socketserver.ThreadingTCPServer.daemon_threads = True  # 多线程：Chromium 预开的空闲连接不会把单线程服务器堵住
socketserver.ThreadingTCPServer.allow_reuse_address = True
httpd = socketserver.ThreadingTCPServer(("127.0.0.1", PORT), Quiet)
threading.Thread(target=httpd.serve_forever, daemon=True).start()

if PROFILE.exists():
    shutil.rmtree(PROFILE, ignore_errors=True)

R = {}
with sync_playwright() as pw:
    ctx = pw.chromium.launch_persistent_context(
        str(PROFILE),
        executable_path=CHROME,
        headless=False,
        ignore_default_args=["--disable-extensions"],
        args=[f"--disable-extensions-except={EXT}", f"--load-extension={EXT}", "--headless=new", "--no-proxy-server"],
        viewport={"width": 1280, "height": 800},
    )
    try:
        sw = ctx.service_workers[0] if ctx.service_workers else ctx.wait_for_event("serviceworker", timeout=20000)
        ext_id = sw.url.split("/")[2]
        R["extension_loaded"] = {"id": ext_id, "sw": sw.url.rsplit("/", 1)[-1]}
        R["defaults"] = sw.evaluate("() => new Promise(r => chrome.storage.local.get(null, r))")

        page = ctx.new_page()
        errs = []
        page.on("pageerror", lambda e: errs.append(str(e)))
        page.goto(f"http://127.0.0.1:{PORT}/article.html")
        page.wait_for_load_state("load")
        time.sleep(1.0)

        def counts():
            return page.evaluate("""() => ({
                nodes: document.querySelectorAll('.deepseek-dual-target').length,
                pending: document.querySelectorAll('.deepseek-dual-pending').length,
                failed: document.querySelectorAll('.deepseek-dual-failed').length,
                total_paras: document.querySelectorAll('p').length })""")

        # 等价于 Alt+A：后台向当前标签页发 toggle 消息
        tab_id = sw.evaluate("""() => new Promise(r => chrome.tabs.query({}, ts => r(ts.find(t => t.url && t.url.includes('article.html')).id)))""")
        R["toggle_reply"] = sw.evaluate("(id) => new Promise(r => chrome.tabs.sendMessage(id, {action:'toggle-page-translate'}, r))", tab_id)

        t0 = time.time()
        R["after_start_counts"] = []
        for _ in range(60):
            time.sleep(1)
            c = counts()
            R["after_start_counts"].append(c["nodes"] - c["pending"])
            if c["nodes"] > 0 and c["pending"] == 0:
                break
        R["first_screen"] = counts() | {"seconds": round(time.time() - t0, 1)}

        def collect():
            return page.evaluate("""() => [...document.querySelectorAll('.deepseek-dual-target')].map(n => ({
                src: n.previousElementSibling ? n.previousElementSibling.innerText.slice(0,60) : '', zh: n.innerText}))""")

        first = collect()
        R["skipped_ok"] = {
            "nav_translated": any("Navigation paragraph" in x["src"] for x in first),
            "footer_translated": any("Footer paragraph" in x["src"] for x in first),
            "pre_translated": any("preformatted" in x["src"] for x in first),
            "chinese_translated": any("已经是中文" in x["src"] for x in first),
            "div_leaf_translated": any("leaf div block" in x["src"] for x in first),
            "li_translated": any("First list item" in x["src"] for x in first),
            "blockquote_translated": any("Quoted analyst" in x["src"] for x in first),
        }
        R["link_kept_in_original"] = page.evaluate("() => !!document.querySelector('a[href=\"#roadmap\"]')")
        page.screenshot(path=str(SCR / "real_1_first_screen.png"))

        # 滚动：懒翻译应继续翻新进入视野的段落
        n_before = counts()["nodes"]
        for _ in range(6):
            page.mouse.wheel(0, 900)
            time.sleep(0.5)
        for _ in range(60):
            time.sleep(1)
            c = counts()
            if c["pending"] == 0 and c["nodes"] > n_before:
                break
        R["after_scroll"] = {"before": n_before, **counts()}

        # 动态页面：点击“加载更多”，新段落应被自动翻译
        page.evaluate("document.getElementById('loadmore').scrollIntoView()")
        page.click("#loadmore")
        time.sleep(1.2)
        page.mouse.wheel(0, 400)
        for _ in range(60):
            time.sleep(1)
            done = page.evaluate("""() => [...document.querySelectorAll('#more p')].map(p => p.nextElementSibling && p.nextElementSibling.classList.contains('deepseek-dual-target') && !p.nextElementSibling.classList.contains('deepseek-dual-pending'))""")
            if done and all(done):
                break
        R["dynamic_translated"] = done
        page.screenshot(path=str(SCR / "real_2_after_scroll_dynamic.png"))

        allt = collect()
        zh_all = "\n".join(x["zh"] for x in allt)
        R["terms_keep_mode"] = {
            "Azure_kept": "Azure" in zh_all, "Kubernetes_kept": "Kubernetes" in zh_all,
            "Microsoft_kept": "Microsoft" in zh_all, "Gartner_kept": "Gartner" in zh_all,
            "Copilot_kept": "Copilot" in zh_all, "Docker_kept": "Docker" in zh_all,
            "Satya_Nadella_kept": "Satya Nadella" in zh_all,
            "bad_zh_names": [w for w in ["高德纳", "微软", "纳德拉", "库伯内特斯"] if w in zh_all],
            "Seattle_to_zh": "西雅图" in zh_all,
        }
        R["samples"] = [f'{x["src"][:50]} => {x["zh"][:140]}' for x in allt[:6]] + [f'{x["src"][:50]} => {x["zh"][:140]}' for x in allt[-3:]]

        # 表格：仅译文模式下单元格里只应有译文，原文被藏起来，行高不被撑成两行
        R["table_cells"] = page.evaluate("""() => {
            const cells = [...document.querySelectorAll('#tbl td, #tbl th')];
            const withTarget = cells.filter(c => c.querySelector(':scope > .deepseek-dual-target'));
            const origVisible = cells.filter(c => {
                const w = c.querySelector(':scope > .deepseek-orig-wrap');
                return w && getComputedStyle(w).display !== 'none';
            });
            const rowHeights = [...document.querySelectorAll('#tbl tbody tr')].map(tr => Math.round(tr.getBoundingClientRect().height));
            return {
                total_cells: cells.length,
                translated_cells: withTarget.length,
                orig_still_visible: origVisible.length,
                cell_text: withTarget.slice(0,3).map(c => c.innerText.replace(/\\n/g,' | ').slice(0,80)),
                row_heights: rowHeights,
                cell_height: cells.filter(c=>c.tagName==='TD').map(c => Math.round(c.getBoundingClientRect().height)),
            };
        }""")
        page.screenshot(path=str(SCR / "real_4_table.png"))

        # 仅译文模式
        sw.evaluate("() => chrome.storage.local.set({displayMode:'only'})")
        time.sleep(0.5)
        R["only_mode_hidden"] = page.evaluate("() => document.querySelectorAll('.deepseek-hide-orig').length")
        sw.evaluate("() => chrome.storage.local.set({displayMode:'dual'})")
        time.sleep(0.5)
        R["dual_mode_hidden"] = page.evaluate("() => document.querySelectorAll('.deepseek-hide-orig').length")
        # 切回双语后，表格单元格里原文应该重新出现
        R["table_dual_mode"] = page.evaluate("""() => {
            const cells = [...document.querySelectorAll('#tbl td, #tbl th')];
            return {
                orig_visible: cells.filter(c => { const w = c.querySelector(':scope > .deepseek-orig-wrap');
                    return w && getComputedStyle(w).display !== 'none'; }).length,
                wraps_left: cells.filter(c => c.querySelector(':scope > .deepseek-orig-wrap')).length,
                cell_text: cells.filter(c=>c.tagName==='TD').slice(0,2).map(c => c.innerText.replace(/\\n/g,' | ').slice(0,80)),
            };
        }""")
        sw.evaluate("() => chrome.storage.local.set({displayMode:'only'})")
        time.sleep(0.5)

        # 关闭：应清理干净
        R["toggle_off_reply"] = sw.evaluate("(id) => new Promise(r => chrome.tabs.sendMessage(id, {action:'toggle-page-translate'}, r))", tab_id)
        time.sleep(0.5)
        R["after_off"] = counts() | {"hidden": page.evaluate("() => document.querySelectorAll('.deepseek-hide-orig').length")}

        # 再开一次：同样的文字应命中缓存，几乎立刻出结果（不再调用模型）
        sw.evaluate("(id) => new Promise(r => chrome.tabs.sendMessage(id, {action:'toggle-page-translate'}, r))", tab_id)
        t1 = time.time()
        for _ in range(40):
            time.sleep(0.5)
            c = counts()
            if c["nodes"] > 0 and c["pending"] == 0:
                break
        R["cache_rerun"] = counts() | {"seconds": round(time.time() - t1, 1)}
        sw.evaluate("(id) => new Promise(r => chrome.tabs.sendMessage(id, {action:'toggle-page-translate'}, r))", tab_id)
        R["page_errors"] = errs

        # ---- 弹窗：真实扩展页里“获取模型”走真实网络请求 ----
        pop = ctx.new_page()
        perrs = []
        pop.on("pageerror", lambda e: perrs.append(str(e)))
        pop.on("console", lambda m: perrs.append("console:" + m.text) if m.type == "error" else None)
        pop.goto(f"chrome-extension://{ext_id}/popup.html")
        pop.wait_for_load_state("load")
        pop.evaluate("document.querySelectorAll('details').forEach(d => d.open = true)")
        before = pop.evaluate("() => document.getElementById('model').options.length")
        pop.click("#fetchBtn")
        for _ in range(20):
            time.sleep(0.5)
            if pop.evaluate("() => document.getElementById('model').options.length") > 10:
                break
        R["popup_fetch_models"] = {
            "options_before": before,
            "options_after": pop.evaluate("() => document.getElementById('model').options.length"),
            "hint": pop.evaluate("() => document.getElementById('modelCount').innerText"),
            "status": pop.evaluate("() => document.getElementById('status').innerText"),
        }
        pop.select_option("#model", "cn:glm-5.3")
        time.sleep(0.4)
        R["popup_model_saved"] = sw.evaluate("() => new Promise(r => chrome.storage.local.get(['model','modelListFor'], r))")
        R["popup_state_on_ext_page"] = pop.evaluate("() => document.getElementById('translateBtn').innerText")
        R["popup_errors"] = perrs
        pop.screenshot(path=str(SCR / "real_3_popup.png"))
    finally:
        ctx.close()
httpd.shutdown()
(SCR / "real_result.json").write_text(json.dumps(R, ensure_ascii=False, indent=1), encoding="utf-8")
print("RESULT_WRITTEN")
