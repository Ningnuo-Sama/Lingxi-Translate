"""真实 Chromium 146：悬浮球 / 永不翻译与始终翻译 / 备用模型切换 / 弹窗新增控件"""
import http.server, json, shutil, socketserver, threading, time
from pathlib import Path
from playwright.sync_api import sync_playwright

EXT = str(Path(__file__).resolve().parent.parent)
CHROME = r"C:\Users\1\.cloakbrowser\chromium-146.0.7680.177.5\chrome.exe"
import tempfile
SCR = Path(tempfile.gettempdir()) / "ds-translator-tests"  # 临时产物（截图、结果 json、测试页）都放这里
SCR.mkdir(exist_ok=True)
WEB = SCR / "web3"  # 复用上一轮的 awesome.html
PORT = 18767
GOOD = "cn:deepseek-v4.1-flash"
BAD = "cn:no-such-model"


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
prof = SCR / "real_profile_float"
shutil.rmtree(prof, ignore_errors=True)


def url(host="127.0.0.1"):
    return f"http://{host}:{PORT}/awesome.html"


with sync_playwright() as pw:
    ctx = pw.chromium.launch_persistent_context(
        str(prof), executable_path=CHROME, headless=False, ignore_default_args=["--disable-extensions"],
        args=[f"--disable-extensions-except={EXT}", f"--load-extension={EXT}", "--headless=new", "--no-proxy-server"],
        viewport={"width": 1100, "height": 900})
    try:
        sw = ctx.service_workers[0] if ctx.service_workers else ctx.wait_for_event("serviceworker", timeout=20000)
        ext_id = sw.url.split("/")[2]
        store = lambda keys=None: sw.evaluate("(k) => new Promise(r => chrome.storage.local.get(k, r))", keys)
        setst = lambda d: sw.evaluate("(d) => new Promise(r => chrome.storage.local.set(d, r))", d)
        errs = []

        def counts(p):
            return p.evaluate("""() => ({n: document.querySelectorAll('.deepseek-dual-target').length,
                p: document.querySelectorAll('.deepseek-dual-pending').length,
                f: document.querySelectorAll('.deepseek-dual-failed').length})""")

        def wait_done(p, limit=90):
            t0 = time.time()
            while time.time() - t0 < limit:
                time.sleep(0.3)
                c = counts(p)
                if c["n"] > 0 and c["p"] == 0:
                    return round(time.time() - t0, 1), c
            return None, counts(p)

        # ===== 1. 悬浮球基本表现 =====
        page = ctx.new_page()
        page.on("pageerror", lambda e: errs.append(str(e)))
        page.goto(url())
        page.wait_for_load_state("load")
        time.sleep(1.2)
        ball = page.locator("#deepseek-float-host").locator(".ball")
        menu = page.locator("#deepseek-float-host").locator(".menu")
        R["ball_present"] = ball.count() == 1
        R["ball_idle"] = ball.evaluate("""el => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el);
            return {class: el.className, left: Math.round(r.left), right: Math.round(r.right), vw: innerWidth, opacity: cs.opacity, bg: cs.backgroundColor, title: el.title} }""")
        page.screenshot(path=str(SCR / "float_1_idle.png"))

        # 悬停 → 不应自动弹菜单（改成了右键才出）
        ball.hover()
        time.sleep(0.9)
        R["menu_after_hover"] = menu.evaluate("el => ({shown: el.classList.contains('show'), text: el.innerText.replace(/\\n+/g,' | ')})")
        page.screenshot(path=str(SCR / "float_2_menu.png"))

        # 右键 → 展开菜单
        ball.click(button="right")
        time.sleep(0.6)
        R["menu_after_rightclick"] = menu.evaluate("el => ({shown: el.classList.contains('show'), text: el.innerText.replace(/\\n+/g,' | ')})")
        page.screenshot(path=str(SCR / "float_2b_menu_rightclick.png"))

        # 点球 → 翻译（球上点击，不走菜单）
        ball.click()
        time.sleep(1.2)
        R["ball_busy_during"] = ball.evaluate("el => el.className")
        secs, c = wait_done(page)
        time.sleep(0.8)
        R["translate_via_ball"] = {"seconds": secs, **c}
        R["ball_after_done"] = ball.evaluate("el => ({cls: el.className, title: el.title})")
        page.screenshot(path=str(SCR / "float_3_translated.png"))

        # 菜单里：样式切换
        ball.click(button="right"); time.sleep(0.6)
        menu.locator("button[data-v='underline']").click()
        time.sleep(0.5)
        R["style_switch"] = {"html_attr": page.evaluate("document.documentElement.getAttribute('data-ds-style')"), "storage": store(["transStyle"])}
        menu.locator("button[data-v='plain']").click()
        time.sleep(0.3)
        # 菜单里：术语处理
        menu.locator("button[data-v='gloss']").click()
        time.sleep(0.3)
        R["term_switch"] = store(["termMode"])
        menu.locator("button[data-v='keep']").click()

        # 菜单里：永不 / 始终（互斥）
        menu.locator("button[data-act='never']").click(); time.sleep(0.4)
        R["never_on"] = store(["autoSites", "neverSites"])
        menu.locator("button[data-act='always']").click(); time.sleep(0.4)
        R["always_on_clears_never"] = store(["autoSites", "neverSites"])
        menu.locator("button[data-act='always']").click(); time.sleep(0.4)
        R["always_off"] = store(["autoSites", "neverSites"])

        # 菜单里：恢复原文
        menu.locator("button[data-act='toggle']").click()
        time.sleep(0.6)
        R["restore_via_menu"] = counts(page)

        # ===== 2. 拖动 =====
        ball.hover(); time.sleep(0.5)
        box = ball.bounding_box()
        cx, cy = box["x"] + box["width"] / 2, box["y"] + box["height"] / 2
        page.mouse.move(cx, cy); page.mouse.down()
        for i in range(1, 11):
            page.mouse.move(cx - i * 80, cy - i * 15)
        page.mouse.up()
        time.sleep(0.6)
        R["drag"] = {"floatPos": store(["floatPos"]), "class": ball.evaluate("el => el.className"),
                     "no_translate_triggered": counts(page)["n"] == 0}
        page.mouse.move(600, 500); time.sleep(0.5)
        page.screenshot(path=str(SCR / "float_4_dragged_left.png"))

        # ===== 3. 隐藏 =====
        ball.click(button="right"); time.sleep(0.6)
        menu.locator("button[data-act='hide']").click(); time.sleep(0.5)
        R["hide_site"] = {"display": page.evaluate("document.getElementById('deepseek-float-host').style.display"),
                          "storage": store(["floatHideSites"])}
        setst({"floatHideSites": []}); time.sleep(0.6)
        R["unhide_by_storage"] = page.evaluate("document.getElementById('deepseek-float-host').style.display")
        setst({"floatBall": False}); time.sleep(0.6)
        R["ball_off_switch"] = page.evaluate("document.getElementById('deepseek-float-host').style.display")
        setst({"floatBall": True}); time.sleep(0.4)
        page.close()

        # ===== 4. 网站规则：localhost 始终翻译，127.0.0.1 永不自动翻译 =====
        setst({"autoSites": ["localhost"], "neverSites": ["127.0.0.1"], "autoAll": False})
        pn = ctx.new_page(); pn.goto(url("127.0.0.1")); pn.wait_for_load_state("load"); time.sleep(6)
        R["rules_never_host_127"] = counts(pn)
        # 永不翻译的站点仍可手动翻译
        pn.locator("#deepseek-float-host").locator(".ball").click()
        secs, c = wait_done(pn)
        R["rules_never_host_manual_ok"] = {"seconds": secs, **c}
        pn.close()
        pa = ctx.new_page(); pa.goto(url("localhost")); pa.wait_for_load_state("load")
        secs, c = wait_done(pa)
        R["rules_always_host_localhost_auto"] = {"seconds": secs, **c}
        pa.close()
        # 永不优先于始终：两边都写 127.0.0.1
        setst({"autoSites": ["127.0.0.1"], "neverSites": ["127.0.0.1"]})
        pb = ctx.new_page(); pb.goto(url("127.0.0.1")); pb.wait_for_load_state("load"); time.sleep(6)
        R["rules_never_beats_always"] = counts(pb)
        pb.close()
        setst({"autoSites": [], "neverSites": []})

        # ===== 5. 备用模型：主模型是不存在的模型，备用是正常模型 =====
        setst({"model": BAD, "fallbackModel": GOOD})
        pf = ctx.new_page(); pf.goto(url()); pf.wait_for_load_state("load"); time.sleep(1.2)
        pf.locator("#deepseek-float-host").locator(".ball").click()
        secs, c = wait_done(pf, 120)
        time.sleep(1.0)
        pball = pf.locator("#deepseek-float-host").locator(".ball")
        R["fallback_translate"] = {"seconds": secs, **c,
                                   "badge_class": pball.evaluate("el => el.querySelector('.badge').className"),
                                   "first_texts": pf.evaluate("() => [...document.querySelectorAll('.deepseek-dual-target')].slice(0,3).map(n => n.innerText)")}
        pball.click(button="right"); time.sleep(0.6)
        R["fallback_menu_note"] = pf.locator("#deepseek-float-host").locator(".menu .note").inner_text()
        pf.screenshot(path=str(SCR / "float_5_fallback.png"))
        pf.close()
        setst({"model": GOOD, "fallbackModel": ""})

        # ===== 6. 弹窗新增控件（真实扩展页） =====
        pop = ctx.new_page()
        perr = []
        pop.on("pageerror", lambda e: perr.append(str(e)))
        pop.goto(f"chrome-extension://{ext_id}/popup.html")
        pop.wait_for_load_state("load")
        pop.evaluate("document.querySelectorAll('details').forEach(d => d.open = true)")
        pop.click("#fetchBtn")
        for _ in range(30):
            time.sleep(0.4)
            if pop.evaluate("document.getElementById('fallbackModel').options.length") > 10:
                break
        R["popup_fallback_options"] = pop.evaluate("document.getElementById('fallbackModel').options.length")
        pop.select_option("#fallbackModel", "cn:glm-5.3-flash"); time.sleep(0.5)
        R["popup_fallback_saved"] = store(["fallbackModel"])
        pop.select_option("#fallbackModel", ""); time.sleep(0.4)
        R["popup_fallback_cleared"] = store(["fallbackModel"])
        pop.fill("#autoRules", "https://News.Example.com/a?b=1\n*.medium.com\nnews.example.com"); pop.press("#autoRules", "Tab"); time.sleep(0.5)
        R["popup_rules_saved"] = {"stored": store(["autoSites"]), "textarea": pop.input_value("#autoRules")}
        pop.fill("#neverRules", "bank.example.com, Mail.Example.com"); pop.press("#neverRules", "Tab"); time.sleep(0.5)
        R["popup_never_saved"] = store(["neverSites"])
        R["popup_site_toggles_on_ext_page"] = {"autoSite_disabled": pop.is_disabled("#autoSite"), "neverSite_disabled": pop.is_disabled("#neverSite")}
        pop.evaluate("document.getElementById('floatBall').click()"); time.sleep(0.4)
        R["popup_floatball_toggle"] = store(["floatBall"])
        pop.evaluate("document.getElementById('selectTranslate').click()"); time.sleep(0.4)
        R["popup_select_translate_toggle"] = store(["selectTranslate"])
        pop.evaluate("document.getElementById('selectTranslate').click()"); time.sleep(0.4)
        pop.screenshot(path=str(SCR / "float_6_popup.png"), full_page=True)
        R["popup_errors"] = perr
        R["page_errors"] = errs
    finally:
        ctx.close()
httpd.shutdown()
(SCR / "float_result.json").write_text(json.dumps(R, ensure_ascii=False, indent=1), encoding="utf-8")
print("DONE")
