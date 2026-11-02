# 交接文档：灵犀翻译 Lingxi Translate（自研开源浏览器翻译扩展）

> 交接日期：2026-11-02　｜　版本：manifest `1.2.0`　｜　位置：`D:\GitHub\DeepSeek-Translator-Extension`
> 维护人：执行 Agent。
> 远端仓库：`https://github.com/Ningnuo-Sama/Lingxi-Translate`

## 0. 一句话

面向开源的纯净浏览器翻译扩展：用本地大模型网关做网页「AI 精翻」（上下文理解、术语保留、仅译文与双语对照、懒翻译预取、独立贴边悬浮球），对标并超越商业扩展的使用体验，代码和提示词 100% 自研。目标语言固定简体中文。

## 1. 仓库与开源维护

| 事项 | 状态/说明 |
|---|---|
| Git 仓库 | `main` 分支已建立完整基线，遵循 MIT 开源协议 |
| 远端仓库 | `https://github.com/Ningnuo-Sama/Lingxi-Translate`（开源 Public） |
| UI/UX | 灵犀现代化深空灰卡片质感设计（340px、iOS 开关、分段器、自定义折叠面板、毛玻璃微光） |
| 交互亮点 | 默认沉浸仅译文模式（表格/卡片单元格内单行排版）；悬浮球右键呼出菜单、左键一键翻译；划词选中翻译双入口可控 |
| 提交规范 | 提交信息末尾带 `Co-Authored-By` 行；不要 `--no-verify`；排除 `tests/__pycache__` 与临时测试产物 |

## 2. 文件地图

| 文件 | 职责 |
|---|---|
| `manifest.json` | MV3；内容脚本按顺序加载 `rules.js` → `content.js` → `float.js`；`<all_urls>` 主机权限；快捷键 Alt+A |
| `background.js` | 后台（service worker）：模型调用、批量翻译、术语、缓存、备用模型断路器、并发限流 |
| `content.js` | 页面端：收集段落、懒翻译（IntersectionObserver）、动态页面（MutationObserver）、回填译文、卡死兜底、自动翻译 |
| `float.js` | 悬浮球（Shadow DOM，只在顶层页面，宽高 <500 不显示）。通过 `globalThis.__DS` 读 content.js 状态 |
| `rules.js` | 网站规则匹配（始终翻译/永不翻译），**内容脚本和弹窗共用**，别在两边各写一份 |
| `content.css` | 译文样式（默认无装饰，`html[data-ds-style]` 切换 muted/underline/bar） |
| `popup.html` / `popup.js` | 弹窗：翻译按钮、开关、术语、样式、网站规则、模型选择与获取、备用模型 |
| `DESIGN-上下文精翻.md` | 早期设计文档（机制说明）。**以本文档为准**，两者有出入处本文档更新 |
| `tests/` | 验证脚本，见第 8 节 |

## 3. 架构与消息协议

```
popup/悬浮球/Alt+A ──► content.js ──translate-page──► background.js（登记任务）
                       │  懒翻译：段落进入视口附近 → enqueue → 占位“翻译中…” → flush 成分块
                       └─translate-chunk{jobId,title,docText,items[{id,text}]}──► background.processChunk
                                      查缓存 → 读全文(ctx) → 分批(8条/批,≤1500字) → 并发调模型 → [[pN]] 解析
                       ◄─page-batch-result{jobId,items[{id,text,ok}],fallback}── 每批译完立即回填
```

- 一个标签页同时只有一个任务（`jobs` Map，key=tabId）。`jobId` 不一致的消息一律作废。
- 批量协议：用户消息 `[[p0]]…[[p1]]…`，模型返回同样标记，末尾 `[[terms]]…[[end]]` 汇报新术语（keep 模式每个术语一行，其余两行：原文/译名）。解析失败的段落**逐段降级**单独翻译，保证不丢。
- 译文节点是原文元素后面的兄弟 `div.deepseek-dual-target`（td/th 例外：放进单元格内部）。字体字号颜色行高由 `matchOriginalLook()` 逐个从原文复制，并抵消原文下边距使译文紧贴原文。

## 4. 存储键（`chrome.storage.local`，默认值见 `background.js` 的 `DEFAULT_CONFIG` 与 `popup.js`）

`apiUrl` `apiKey` `model` `fallbackModel` `noThinking`(默认 true) `contextMode`(默认 true) `termMode`(keep|gloss|translate，默认 keep) `noTranslate`(多行文本) `transStyle`(plain|muted|underline|bar) `displayMode`(dual|only) `selectTranslate`(默认 true) `autoSites` `neverSites`(规则数组，格式见 `rules.js`) `autoAll` `floatBall`(默认 true) `floatPos{side,top}` `floatHideSites` `modelList` `modelListFor`。
译文缓存与上下文缓存在 `chrome.storage.session`（浏览器关闭即清）：`t:*`（译文，FIFO 上限 1500）、`ctx:*`、`tc:idx`。

## 5. 关键设计决策（含实测依据，改动前请先看）

1. **默认关闭模型思考**：请求体带 `thinking:{type:"disabled"}`。实测同一批 8 条：思考开平均 4.2s（2.0–7.4s，平均白生成 ~410 个思考 token），关平均 2.0s（1.7–2.4s），质量无退化。网关若因未知参数返回 400，自动去掉参数重发并记住（`thinkingRejected`）。
2. **全局在途请求上限 `MAX_INFLIGHT = 5`**：网关实测 6 路并发全部正常，**第 7 路起返回 `503 no_healthy_account`**，限流后单发立刻恢复。读全文、批次、逐段降级、划词共用这个上限。曾因「读全文 + 6 批」= 7 路而出现整批失败，已修。瞬时错误有退避重试（0.4s/0.8s + 抖动，默认重试 2 次）。
3. **读全文（ctx）不阻塞首屏**：只取页面开头 `DOC_TEXT_LIMIT=3000` 字、术语上限 24 条（实测 ~2.4–2.9s）；第一批最多等 `CTX_WAIT_MS=2500`，超时先翻，之后的批次自动带上。结果缓存。
4. **懒翻译 + 预取**：IntersectionObserver `rootMargin` = 视口上方 0.5 屏、下方 2 屏（沉浸式翻译同样往下预取约 2 屏）。滚动前已译好。
5. **后台被系统回收的三层防护**（MV3 service worker 空闲约 30s 即回收，内存任务表会丢；这是用户实际遇到的“下面一片翻译中…”的根因）：
   - 分块消息每次都带 `title/docText`，后台找不到任务时**就地重建**；
   - 翻译进行中每 20s 调一次扩展 API 保活（`busyStart/busyEnd`）；
   - 页面端 `checkStuck()`：发出超过 35s 没回来的段落自动重发，最多 2 次，仍无果标红“点击重试”。
6. **备用模型断路器**：主模型失败 → 本次请求立刻改用备用；连续失败 2 次 → 主模型冷却 120s 期间直接走备用；冷却结束自动再试。只配同一接口地址下的另一个模型名。页面端在悬浮球上显示橙点与提示。
7. **术语三档**（`termSection()` 是唯一来源，批量/降级/划词共用）：
   - `keep`：人名、公司/产品/库/框架/模型名、缩写、代码标识符、**没有通行中文译名的专业术语**保留英文；有通行译名的概念（machine learning→机器学习）和国家城市地名必须翻译；中英文之间加空格。
   - `gloss`：首次出现“译名（原文）”，靠确定性后处理 `polishGloss()` 保证：只留含大写字母的括注、同一术语整页只括注一次、清掉 `X（X）`。
   - `translate`：旧行为。
   - 术语策略和 `noTranslate` 都进了译文缓存键，切换后不会读到旧译文。
8. **永不翻译优先于始终翻译**；永不翻译的站点仍可手动翻译（悬浮球/弹窗/Alt+A）。规则写法：`example.com`（含子域）、`*.example.com`（含主域）、整条网址只取主机名。
9. **悬浮球交互参照沉浸式翻译配置**：默认半透明（opacity .7）贴边、悬停约 0.4s 展开菜单、可拖动并吸附左右、可按站点隐藏、全屏/打印隐藏。

## 6. 本地环境事实

- **模型网关**：`http://127.0.0.1:7863/v1/chat/completions`，Bearer `admin`，OpenAI 兼容，`/v1/models` 返回 81 个（含 `cn:` 与 `global:` 前缀，**不只是文本模型**，选模型时注意）。默认模型 `cn:deepseek-v4.1-flash`。不存在的模型返回 `503 no_healthy_account`（约 3.8s）。
- **用户主浏览器 Chrome 156**：正式版 Chrome 137 起不支持命令行 `--load-extension`，**只能手动**：`chrome://extensions` → 开发者模式 → 加载已解压的扩展程序 → 选本目录。已装在 **Profile 4**（账号 `jyf1023984518@gmail.com`，扩展 ID `pblocieephhhdmcpmohbhifapoeeecgh`，由路径算出）。改代码后在扩展页点刷新图标，并刷新网页。
- **自动化测试浏览器**：CloakMulti 自带的 Chromium 146（`C:\Users\1\.cloakbrowser\chromium-146.0.7680.177.5\chrome.exe`），支持命令行加载扩展，运行用 `D:\GitHub\CloakMulti\venv\Scripts\python.exe`（带 playwright）。
- **Claude in Chrome 未连接**，无法在用户主浏览器里自动点测；主浏览器内的真实表现只能靠用户反馈。
- 运行测试时设 `NO_PROXY=127.0.0.1,localhost`；所有进程静默运行，不得弹出黑窗。

## 7. 沉浸式翻译的参照（只读，已确认的事实）

归档位置 `D:\GitHub\CloakMulti\extensions_disabled_20261021\immersive-translate`（只读参考，**已被我在 10 月 19 日改过会员判断，不能当官方原版**；不得分发）。从其 `default_config.json` 读到的、已借鉴的做法：每请求 8 条（`itemsPerRequest`）、往下预取约 2 屏（`visibleObserverScreens [0,0,2,0]`）、每个翻译服务有速率限制配置、允许多路并发（`getDefaultRateLimit` 里见到 `{limit:7,interval:1250}`、`{limit:3,interval:1350}`，AI 服务类里是 `{limit:10,interval:1300}`，即约每 1.3 秒最多 10 个请求，具体取决于服务；我们受本地网关 6 路上限约束，取 5）、AI 批处理默认 `enableArticleTerminology:false`（不读全文）、悬浮球 `transparency:30`、`hoverSidePanelDelay:500`、网站规则支持 `*.medium.com`。代码里有 `stream:!0`（流式）——**我们还没做流式**。

## 8. 验证脚本（`tests/`，临时产物写系统临时目录 `%TEMP%\ds-translator-tests`）

| 脚本 | 内容 |
|---|---|
| `node_term_modes.js` | 术语三档/不翻译词表（`MODE=keep|gloss|translate`，`SET=ml` 用 AI 工具列表，`NOTRANS=a,b`） |
| `node_fallback_breaker.js` | 备用模型 + 断路器 + 冷却恢复 |
| `node_job_lost.js` | 后台任务丢失后分块自愈 |
| `node_gateway_probe.js` | 网关并发上限与读全文耗时 |
| `e2e_page_flow.py` | 真实 Chromium：整页/懒翻译/动态页面/过滤规则/术语/缓存/弹窗获取模型 |
| `e2e_style_speed.py` | 译文样式截图 + 关闭思考速度对照（**同时生成 `web3/awesome.html`，`e2e_float_rules_fallback.py` 依赖它，先跑这个**） |
| `e2e_float_rules_fallback.py` | 悬浮球、网站规则、备用模型、弹窗新控件；跑完用 `python -X utf8 check_float_result.py` 汇总 19 项 PASS/FAIL |
| `check_float_result.py` | 汇总上面脚本的结果（纯 Python，无需浏览器） |
| `e2e_recovery.py` | 160 条长页面：后台任务丢失/消息被吞自愈 + 预取 + 首屏速度 |

运行：`cd tests` → `node node_xxx.js`；`D:\GitHub\CloakMulti\venv\Scripts\python.exe -X utf8 -I e2e_xxx.py`（结果 JSON 在临时目录）。`python -I` 会忽略 `PYTHONUTF8`，需显式 `-X utf8`，否则中文乱码。

## 9. 当前验证状态（2026-11-02 实测）

**`tests/` 里的脚本已在项目目录内实跑通过**（`e2e_style_speed.py` → `e2e_float_rules_fallback.py` → `check_float_result.py` 19/19 PASS；`e2e_recovery.py` 连跑两次 0 失败；node 三个脚本通过）。e2e 脚本的静态服务器必须是多线程的（Chromium 预开空闲连接会堵死单线程服务器，曾造成偶发的 goto 超时）。

**已验证（真实 Chromium 146 + 真实本地模型）**：整页翻译、懒翻译与预取、动态页面、跳过规则（nav/footer/pre/中文/代码）、术语三档、缓存（二次打开 ~0.5s）、显示模式、悬浮球全部交互、永不/始终规则及优先级、备用模型切换与提示、弹窗新控件、后台任务丢失与消息被吞自愈。最近一次：160 条长页面首条译文 3.7–4.5s、48 条 5.9–6.2s 译完，0 失败。

**未验证 / 风险**：
- 用户 **Chrome 156 + 真实网站**：只有用户反馈，没有自动化覆盖。建议用户多试信息流、技术文档（大量代码块）、表格多的页面、单页应用。
- 超大页面（数千段）性能；iframe 内的内容（内容脚本只在顶层）；Shadow DOM 内的文本；RTL 语言页。
- 表格单元格在仅译文模式下已验证单行排版正常（行高 28px，原文隐藏，切回双语可无损还原）；`muted` 样式没单独看过。
- `gloss` 模式有已知小瑕疵：`Azure regions` 这类带大写词的普通短语仍会被括注；`keep` 下模型偶尔把 `Transformer architecture` 整体保留。

## 10. 已知问题与限制

- `div` 里既有文字又有子段落时，这个 `div` 自己的那段文字会被漏翻（候选必须是最内层叶子块）。
- 仅译文模式下原文里的链接/加粗在纯文本替换时会丢（双语模式不受影响；td/th 单元格已支持原地隐藏原文消除堆叠）。
- 并发批次之间“上一批译文当上下文”的滑动窗口只能用已完成的批次，连贯性比串行时弱；术语表与主题摘要不受影响。
- 读全文超过 2.5s 才完成时，首屏几批没有主题/术语表，之后批次才带上。
- 缓存在浏览器关闭后失效；没有按域名持久化术语表。
- 译文缓存键用 32 位哈希 + 长度，1500 条上限内碰撞概率可忽略，但并非严格唯一。

## 11. 建议待办（按价值排序，用户已表态“高优先级的基本够用，继续优化即可”）

1. **流式输出**：沉浸式翻译代码里有 `stream:!0`。批量响应按 `[[pN]]` 增量解析，边生成边回填，可把首条译文时间再压低（总时长不变）。注意解析要容忍半截标记。
2. **只翻正文区域**：避开侧边栏/推荐位/评论，更干净更快。
3. **术语表手动编辑 / 点击修正 / 一键加入不翻译词表**。
4. **重新翻译某一段**（译文悬停小按钮）。
5. 仅译文模式保留链接与加粗；译文进度提示条；设置导出/备份；按域名持久化术语。
6. 把验证脚本接成一个总入口，并加入断言式汇总。

## 12. 红线（用户明确的，务必遵守）

- **不破解、不修改沉浸式翻译的会员/云端校验**；不复制它的源码；它的归档目录只读不分发。借鉴思路、提示词自写。
- 不要提议用户付费解锁；用户要的是自己实现的完整功能。
- 不要改用户 Chrome 的配置/其他扩展；不要在用户的 Profile 里写入任何东西（我只做过只读检查）。
- 保持静默执行：不得出现控制台黑窗；不用 `.bat/.vbs` 之类脚本包装。
- 用户偏好：结论先行、大白话；译文默认**无装饰沉浸样式**；速度优先于“读全文”的完美。
- 任何破坏性操作（删除、覆盖用户配置）先问。
