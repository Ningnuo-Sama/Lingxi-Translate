// 网站规则：内容脚本和弹窗共用同一份匹配逻辑，避免两边判断不一致
// 写法：example.com（含子域）｜*.example.com（含 example.com 本身）｜含 * 的通配｜直接粘贴整条网址也行，只取主机名

function normalizeRule(raw) {
  return String(raw || "")
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, "") // 去协议
    .replace(/[\/?#].*$/, "") // 去路径、查询、锚点
    .replace(/:\d+$/, ""); // 去端口
}

// 返回命中的那条规则（已规范化），没命中返回 ""
function matchedRule(rules, host) {
  host = String(host || "").toLowerCase();
  for (const raw of rules || []) {
    const r = normalizeRule(raw);
    if (!r) continue;
    if (r.includes("*")) {
      const re = new RegExp("^" + r.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$");
      if (re.test(host) || (r.startsWith("*.") && host === r.slice(2))) return r;
    } else if (host === r || host.endsWith("." + r)) {
      return r;
    }
  }
  return "";
}

const hostMatches = (rules, host) => matchedRule(rules, host) !== "";

// 在“始终翻译 / 永不翻译”两个列表里切换当前站点（kind: "always" | "never"）。
// 开启一边会把本站从另一边的精确条目里移除；永不翻译优先级最高。
// 返回 { always, never, blockedBy }：blockedBy 非空表示本站被一条更宽的规则命中（如 *.example.com），
// 在这里改不掉，需要用户去“网站规则”里改那一条
function setSiteRule(always, never, host, kind, on) {
  const h = normalizeRule(host);
  const lists = { always: (always || []).map(normalizeRule).filter(Boolean), never: (never || []).map(normalizeRule).filter(Boolean) };
  const other = kind === "always" ? "never" : "always";
  const without = (arr) => arr.filter((r) => r !== h);
  let blockedBy = "";

  if (on) {
    if (!matchedRule(lists[kind], h)) lists[kind].push(h);
    lists[other] = without(lists[other]);
    // 想开“始终翻译”，但本站被更宽的“永不翻译”规则压着，开了也不会生效
    if (kind === "always") blockedBy = matchedRule(lists.never, h);
  } else {
    lists[kind] = without(lists[kind]);
    blockedBy = matchedRule(lists[kind], h);
  }
  return { always: lists.always, never: lists.never, blockedBy };
}

// 文本框内容（换行或逗号分隔）→ 去重后的规则数组
function parseRules(text) {
  const seen = new Set();
  const out = [];
  for (const part of String(text || "").split(/[\n,，;；]+/)) {
    const r = normalizeRule(part);
    if (r && !seen.has(r)) {
      seen.add(r);
      out.push(r);
    }
  }
  return out;
}
