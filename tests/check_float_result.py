"""汇总 e2e_float_rules_fallback.py 的结果 JSON，逐项给出 PASS/FAIL（21 项）。
用法：先跑 e2e_style_speed.py（生成测试页），再跑 e2e_float_rules_fallback.py，最后跑本脚本。"""
import json, os, sys, tempfile

p = os.path.join(tempfile.gettempdir(), "ds-translator-tests", "float_result.json")
d = json.load(open(p, encoding="utf-8"))
chk = {
    "球存在且贴右半透明": d["ball_present"] and d["ball_idle"]["class"] == "ball right" and d["ball_idle"]["opacity"] == "0.7",
    "悬停不弹菜单（改右键）": not d["menu_after_hover"]["shown"],
    "右键展开菜单": d["menu_after_rightclick"]["shown"],
    "点球翻译完成": d["translate_via_ball"]["p"] == 0 and d["translate_via_ball"]["n"] >= 29,
    "翻译中有转圈、完成变 on": "busy" in d["ball_busy_during"] and " on" in d["ball_after_done"]["cls"],
    "样式切换": d["style_switch"]["html_attr"] == "underline",
    "术语切换": d["term_switch"]["termMode"] == "gloss",
    "永不→始终互斥": d["never_on"]["neverSites"] == ["127.0.0.1"] and d["always_on_clears_never"]["neverSites"] == [] and d["always_on_clears_never"]["autoSites"] == ["127.0.0.1"],
    "菜单恢复原文": d["restore_via_menu"]["n"] == 0,
    "拖动吸附到左边并记住位置": d["drag"]["floatPos"]["floatPos"]["side"] == "left" and d["drag"]["no_translate_triggered"],
    "本站隐藏/恢复/总开关": d["hide_site"]["display"] == "none" and d["unhide_by_storage"] == "" and d["ball_off_switch"] == "none",
    "永不翻译站点不自动翻": d["rules_never_host_127"]["n"] == 0,
    "永不翻译站点仍可手动翻": d["rules_never_host_manual_ok"]["n"] >= 29,
    "始终翻译站点自动翻": d["rules_always_host_localhost_auto"]["n"] >= 29,
    "永不优先于始终": d["rules_never_beats_always"]["n"] == 0,
    "备用模型接管并提示": d["fallback_translate"]["p"] == 0 and d["fallback_translate"]["badge_class"] == "badge fb" and "备用模型" in d["fallback_menu_note"],
    "弹窗备用模型选择/清除": d["popup_fallback_saved"]["fallbackModel"] == "cn:glm-5.3-flash" and d["popup_fallback_cleared"]["fallbackModel"] == "",
    "弹窗规则规范化保存": d["popup_rules_saved"]["stored"]["autoSites"] == ["news.example.com", "*.medium.com"] and d["popup_never_saved"]["neverSites"] == ["bank.example.com", "mail.example.com"],
    "弹窗悬浮球开关": d["popup_floatball_toggle"]["floatBall"] is False,
    "弹窗划词翻译开关": d.get("popup_select_translate_toggle", {}).get("selectTranslate") is False,
    "无页面/弹窗报错": d["page_errors"] == [] and d["popup_errors"] == [],
}
for k, v in chk.items():
    print("PASS" if v else "FAIL", k)
ok = all(chk.values())
print("ALL_PASS" if ok else "HAS_FAIL")
sys.exit(0 if ok else 1)
