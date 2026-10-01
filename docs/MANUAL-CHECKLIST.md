# dsh-LogWiki · 验收清单

> **门禁规则**：每一项必须有证据（命令 + 输出摘要，或截图路径）才能打勾。未全部通过前**不得**宣布开发完成、不得归档协作团队、不得清理 `dev/logwiki.patch.yml` 与自管实例。最终签字由你来做。

分层：**L1** = 我自管的 3081 实例；**L2** = 你日常的 3080 实例（通过 L1 后才做）。

---

## A. 自动化（L1）

跑一条命令即可：

```powershell
node dsh-logwiki\scripts\accept-l1.mjs http://127.0.0.1:3081 --probe
```

覆盖项与预期：

| # | 项 | 预期 |
|---|---|---|
| A1 | `/ping` 可达并回显配置 | HTTP 200，`scan.sinceDays`/`summarize` 有值 |
| A2 | 五个兄弟模块就绪 | `extract/fold/store/summarize/prompts` 全 true |
| A3 | `/health` 可达 | HTTP 200 |
| A4 | 工具 `logwiki_write_digest` 已注册 | `tools.registered` 含它，`tools.errors` 为空 |
| A5 | store 可写 | `store.writable === true` |
| A6 | 变更端点缺守卫头 → 403 | 「缺 x-logwiki: 1 头」 |
| A7 | OPTIONS → 405 | 不实现 CORS 预检 |
| A8 | 变更端点 GET → 405 | 只收 POST |
| A9 | `POST /refresh` 受理并跑完 | `scan.done === true` |
| A10 | `/state` 有活动日 | 至少一天 `turns/entries > 0` |
| A11 | 本地来源存在 | `sources` 含 `kind:'local'` |
| A12 | `/day` 有工作区卡与条目卡 | 条目非空、按 `startTime` 升序 |
| A13 | 条目编辑持久化 | 改后重读 `edited === true` 且内容为改后值 |
| A14 | `/digests/available` 可达 | HTTP 200 |
| A15 | 真机 LLM 自检（`--probe`） | `{ok:true, provider, model}` |

**证据**：把整段输出贴进 `DEVLOG.md`。

## B. 静态检查（L1）

```powershell
cd dsh-logwiki
# lib/ 下**全部** .js 逐个过语法门。此前这行是手写枚举，出过两个问题：
#   1) store.js 与 client.js 各被检查了两遍（重复）；
#   2) remote.js 与 remote-sources.js 从未进过门（漏检）。
# 改成遍历，新增模块自动纳入。
Get-ChildItem lib\*.js | ForEach-Object { node --check $_.FullName; if ($LASTEXITCODE -ne 0) { throw "syntax: $($_.Name)" } }
node scripts/verify-extract.mjs      # 线 A 的真数据提取自检
node scripts/verify-prompts.mjs      # 线 B 的提示词/解析/契约自检
node scripts/verify-remote.mjs       # 远程来源逻辑 / 工具 schema / 路径派生 / 按实例分库 / 隐私门
```

| # | 项 | 预期 |
|---|---|---|
| B1 | `lib/` 下全部 `.js`（当前 **11 个**：index / client / extract / fold / store / summarize / prompts / vendor-dsh / paths / remote / remote-sources）语法全绿 | 上一条命令 exit=0，无抛出 |
| B2 | 挂载证据 | `dsh --profile web --patch dev\logwiki.patch.yml --dump-config` 出现 `# == ...\dev\logwiki.patch.yml` + `- id: logwiki` |
| B3 | 共享 profile 未被改动 | 同一 dump 里 `# == dsh-overleaf, patched by ...\profiles\web\cordis.patch.yml` 仍在 |
| B4 | 离线提取自检 | 无断言的失败 |
| B5 | 提示词自检 | 103 项全绿 |
| B6 | 远程来源自检 | `verify-remote.mjs` 全绿（含隐私门：`lib/` 与 `scripts/` 里不出现真实用户名路径） |

## C. 界面与交互（L1，需截图 + 你确认）

| # | 项 | 证据 |
|---|---|---|
| C1 | 左栏图标条出现「任务日历」，位置与「插件」「任务看板」同列 | 截图 |
| C2 | 点击切到整页日历，左栏图标为激活态 | 截图 |
| C3 | **年视图热力图**：53×7 网格、月份/星期标签、5 档色阶；悬浮 tooltip 显示 日期/工作量/会话数/条目数 | 截图 |
| C4 | **指标切换**（回合/Token/会话数/条目数）后重绘 | 截图 |
| C5 | **月视图**：7 列月历、格内日号+强度+条目数+标签 chip，可前后翻月 | 截图 |
| C6 | 点某天 → **三层卡片**：来源（本机）→ 工作区 → 条目；条目按时间升序、每条一句话 + 标签 chip | 截图 |
| C7 | **改一条摘要** → 保存 → 刷新页面仍在；再点「更新」不被覆盖 | 截图 ×2 |
| C8 | **「更新」按钮**有进度（SSE）与失败计数，完成后新日期出现 | 截图 |
| C9 | **周总结** ≤12 条；再次打开不重算；「重新生成」才覆盖 | 截图 ×2 |
| C10 | **月总结**同样 ≤12 条（不是上百条） | 截图 |
| C11 | **「交给智能体」**：提示词被写进输入框（或给出可复制文本框），发出去后智能体能调用 `logwiki_write_digest` 落库 | 截图 |
| C12 | 深浅色主题切换正常；窄窗口与滚动正常 | 截图 |

> ⚠️ **C12 的环境口径（必须按此写，不许写成"深浅色两套已验证"）**
> 本机装有第三方插件 `dsh-dream-skin`，其「午夜黑」皮肤**强制深色**，DSH 内置「外观 → 浅色」完全失效。
> 因此：
> - **原生浅色主题在本环境无法验证**（点了不生效）。
> - 浅色截图与浅色对比度是在**换皮肤（切到「干净明亮」）**的条件下测得的；测完已切回「午夜黑」恢复原状。
> - 更糟的组合：皮肤把 `--dsw-alias-bg-base` 覆盖成 **10% 半透明**，在「深壁纸 + 浅色主题」下组件根面合成成 `#3b3b3e`，而文字是 `#0f1b33` → 近乎不可读。**判为已知环境限制、不阻塞**。
> - 结论措辞应为：**深色已实测通过；浅色仅在换皮肤条件下实测通过；原生浅色受第三方皮肤阻断，未能验证。**
| C13 | **任一区块报错不白屏**（错误边界兜底） | 破坏性验证或代码走查说明 |
| C14 | 空态/加载态/错误态文案像样（如 `scan.done=false` 时显示"正在回填历史…"） | 截图 |

## C+. 视觉与交互精修（Operate 模式「年度台账」）

> **契约**：`docs/DESIGN.md`（本轮唯一设计依据）。
> **范围**：只改 `dsh-logwiki/lib/client.js`；零接口变更、零 Host 改动。
> **通用证据形式**：截图放 `docs/screenshots/`；命令与 DOM 输出贴进本节对应条目（或 `DEVLOG.md`）。

### C15 · 颜色职责分离——绿色只剩「量」这一件事

**验收动作**

1. 年视图（浅色主题）截全图；再切深色主题截一张。
2. 控制台逐项采样并打印 `getComputedStyle`：
   ```js
   const pick = (sel, prop='backgroundColor') => [sel, getComputedStyle(document.querySelector(sel))[prop]];
   console.table([
     pick('button[title^="增量扫描"]'),        // 「更新」主操作
     pick('.lw-chip.lw-on'),                  // 选中的来源 chip
     pick('.lw-tag'),                         // 条目标签 chip（先在抽屉里打开一天）
   ]);
   ```
3. 统计写死颜色只出现一次：
   ```powershell
   node -e "const t=require('fs').readFileSync('dsh-logwiki/lib/client.js','utf8');const m=t.match(/#39d353/gi)||[];console.log('39d353 x'+m.length);if(m.length!==1)process.exit(1)"
   ```

**期望**

- 「更新」/选中 chip 的底色解析为 `--dsw-alias-brand-primary`（浅色 `rgb(15, 17, 21)`，深色 `rgb(249, 250, 251)`），文字为 `--dsw-alias-label-primary-foreground`。
- 标签 chip 底 `rgba(0, 0, 0, 0)`（透明），边框色解析为 `--dsw-alias-border-l3`。
- 整页除**热力图色阶 / 月视图强度条 / 图例**外，无任何绿色系填充或文字。

**证据形式**：`docs/screenshots/ui-year-heatmap-dark.png`（深色：绿只在热力图/图例、主操作与选中态为品牌色、chip 中性）、`ui-year-heatmap-light.png`（浅色同项）；上面两段命令的完整输出。

### C16 · 年视图热力图数据自适应

**验收动作**：窗口宽度依次调到 **1440 / 1280 / 1080 / 640**，每档等布局稳定后跑：

```js
const s = document.querySelector('.lw-scroll');
const c = document.querySelector('.lw-cell');
console.log({ w: innerWidth, scrollW: s.scrollWidth, clientW: s.clientWidth, cell: c.getBoundingClientRect().width, overflow: s.scrollWidth > s.clientWidth + 1 });
```

**期望**

- 1440 / 1280 / 1080：`overflow === false`（**宽窗不出现横向滚动条**）。
- 单元格边长 = `clamp((容器宽 − 星期栏 − 3×(53−1)) / 53, 8, 22)`，四档分别落在 `(8, 22]` 区间内且随视口单调不增。
- 640：`cell === 8`（触底），`overflow === true`（出现横向滚动）。
- 网格几何自洽：`格子右边最大坐标 + 边长 ≤ s.clientWidth`（未触底时）。

**空格子可辨识性（实测采样记录，有意保留的例外，不是遗漏）**

浅色主题下 `bg-base` / `bg-layer-1/2/3` **全都是 `#fff`**，所以"0 档空格子 + 1px 内描边"在浅色下对比度天然偏低。实测（按档位底色 vs 描边色取色计算）：

| 主题 | 0 档底 / 内描边 | 对比度 |
|---|---|---|
| 浅色 | `bg-skeleton` vs `border-l1` | **1.09** |
| 深色 | `bg-skeleton` vs `border-l1` | **1.27**（底/描边分别为 1.27 / 1.19） |
| 浅色（若把内描边升到 `border-l2`） | — | 1.26 |
| 深色（同上） | — | 1.46 |

**裁定**：`ui-crafter` 曾建议把基础内描边从 `--dsw-alias-border-l1` 升到 `-l2`（可把空格子可辨识性提到 1.26 / 1.46）。
**队长已亲自复核浅色截图，判定空格子在浅色下清晰可辨、网格结构读得出，故不改 token** —— `DESIGN.md §3.3` 仍钉 `border-l1`。
本表作为**有意保留的例外**留档备查。

**证据形式**：`docs/screenshots/ui-year-heatmap-dark.png`、`ui-year-heatmap-light.png`、`ui-narrow-640-dark-EXTRA.png`；四档 `console.log` 输出（贴成一张表）。

### C17 · 年度台账栏是低对齐度度量表，不是大数字 hero

**验收动作**

1. 视口 ≥1080px，年视图截图。
2. 控制台跑：
   ```js
   const L = document.querySelector('.lw-ledger');
   const els = [...L.querySelectorAll('*')];
   console.log({
     width: L.offsetWidth,
     maxFontSize: Math.max(...els.map(e => parseFloat(getComputedStyle(e).fontSize))),
     maxFontWeight: Math.max(...els.map(e => parseInt(getComputedStyle(e).fontWeight, 10) || 0)),
     gradients: els.filter(e => getComputedStyle(e).backgroundImage.includes('gradient')).length,
     rows: L.querySelectorAll('.lw-ledger-row').length,
   });
   ```

**期望**：`width === 216`；`maxFontSize <= 14`；`maxFontWeight <= 500`；`gradients === 0`；`rows >= 5`（轮次/会话/条目/Token/活跃日…）。
台账栏与主区之间是 1px `--dsw-alias-border-l1` 分隔线，不是卡片阴影。

**证据形式**：DOM 输出 + `docs/screenshots/ui-year-heatmap-dark.png`（右侧 216px 台账栏与 8 行度量表）。

### C18 · 日详情抽屉 = 行式台账（零卡框）

**验收动作**

1. 点任意活跃日打开抽屉，截全图。
2. 统计抽屉内的「卡框」数量：
   ```js
   const d = document.querySelector('.lw-drawer');
   const cards = [...d.querySelectorAll('*')].filter(e => {
     const s = getComputedStyle(e);
     return s.borderTopWidth !== '0px' && s.borderLeftWidth !== '0px' && s.borderRightWidth !== '0px' && s.borderBottomWidth !== '0px'
       && s.borderRadius !== '0px';
   });
   console.log('四边框+圆角的元素数 =', cards.length, cards.map(e => e.className));
   ```
3. 从抽屉头开始按 `Tab`，记录焦点序列。

**期望**：`cards.length === 0`（来源/工作区/条目三层**都不再是盒子**，层级靠缩进与 1px 分隔线表达）；同一个条目行的「时间 / 标签 chip / 编辑 / 删除」在同一视觉行内；`Tab` 顺序严格等于 DOM 顺序，且与 `docs/DESIGN.md` §8.3 列出的顺序一致。

**证据形式**：`docs/screenshots/ui-day-ledger-dark.png`（2026-09-29，17 条）；卡框计数输出 + Tab 序列输出。

### C19 · 浏览器表面（选区 / 光标 / 滚动条 / 焦点环）

**验收动作**

1. 在页面里选中一段摘要文字，截图。
2. 运行：
   ```js
   const st = document.querySelector('style[data-plugin-css]').textContent;
   const need = ['::selection', 'caret-color', 'scrollbar-color', 'scrollbar-width',
                 '--dsw-alias-bg-document-selection', '--dsw-alias-scrollbar-bg-l1',
                 '--dsw-alias-scrollbar-bg-l2', '--dsw-alias-scrollbar-hover-l1', '--dsw-alias-scrollbar-hover-l2'];
   console.log(need.map(n => [n, st.includes(n)]));
   console.log('focus-ring-width =', getComputedStyle(document.documentElement).getPropertyValue('--dsw-focus-ring-width'));
   console.log('selection token   =', getComputedStyle(document.documentElement).getPropertyValue('--dsw-alias-bg-document-selection'));
   ```
3. 鼠标点一下空白处，再按 `Tab` 聚焦到「更新」按钮，截图。

**期望**：9 个字符串全部 `true`；`--dsw-focus-ring-width` = `2px`；选区底色为蓝系半透明（不是浏览器默认）；`Tab` 聚焦后按钮外沿可见 **2px 环 + 2px 外扩**（`outline-offset: 2px`）；且**没有**用 `outline` 简写（见 DESIGN §2.6）。

**证据形式**：上面两端输出（令牌存在性与 `--dsw-focus-ring-width=2px`）。*交互态特写（选中文字/焦点环）本轮未单独留存*；如需发布图，按本节动作补拍 `ui-c19-selection.png` / `ui-c19-focus.png`。

### C20 · 动效契约（120 / 150 / 180，reduced-motion 全关）

**验收动作**

1. 抽出注入样式里所有时长：
   ```js
   const st = document.querySelector('style[data-plugin-css]').textContent;
   const times = [...st.matchAll(/\b(\d+(?:\.\d+)?)(ms|s)\b/g)].map(m => m[0]);
   console.log('时长集合 =', [...new Set(times)].sort());
   ```
2. DevTools → Rendering → **Emulate CSS media feature `prefers-reduced-motion: reduce`**，再跑：
   ```js
   const c = document.querySelector('.lw-cell');
   console.log(getComputedStyle(c).transitionDuration, getComputedStyle(c).animationDuration);
   ```
3. 全局搜 `animation-delay` / `stagger`，确认没有加载编排动效。

**期望**：时长去重后 ⊆ `{120ms, 150ms, 180ms, 1.4s}`（`1.4s` 只允许是骨架屏呼吸 `lw-pulse`；过渡一律用毫秒写法）；reduce 下两个值都是 `0s`；`animation-delay` 在全文件出现 0 次；`@keyframes` 只保留 `lw-pulse`（可见动画）。

**证据形式**：三端输出（时长集合 ⊆ {120,150,180ms,1.4s}、reduce 下 `0s`）。*reduced-motion 截图本轮未单独留存*；如需发布图，按本节动作补拍 `ui-c20-reduced.png`。

### C21 · 键盘与语义（role=grid / roving tabindex / 方向键）

**验收动作**

1. 年视图跑：
   ```js
   console.log({
     grid: document.querySelectorAll('[role=grid]').length,
     cells: document.querySelectorAll('[role=gridcell]').length,
     rovingZero: [...document.querySelectorAll('[role=gridcell]')].filter(e => e.tabIndex === 0).length,
     rowcount: document.querySelector('[role=grid]')?.getAttribute('aria-rowcount'),
     colcount: document.querySelector('[role=grid]')?.getAttribute('aria-colcount'),
   });
   ```
2. 纯键盘走一遍：`Tab` 进网格 → `→ ↑ ← ↓ Home End` → `Enter` / `Space` 选中 → 观察抽屉是否打开、`data-selected="1"` 是否跟着焦点走。
3. 每次按键后打印 `document.activeElement.getAttribute('aria-label')`。

**期望**：`grid === 1`；`cells === 371`（53×7）；**`rovingZero === 1`**（任何时刻只有一个格子可 Tab）；`rowcount="7"`、`colcount="53"`；方向键按 DESIGN §8.1 第 5 条移动且在第 1/53 列处夹住不循环；`Enter` / `Space` 与鼠标点击等价。

**证据形式**：上面两段输出 + 按键焦点序列（实测 `rovingZero===1`、方向键 ±1 周 / ±1 日、Enter/Space 均开抽屉）。*键盘态截图本轮未单独留存*；如需发布图，按本节动作补拍 `ui-c21-keyboard.png`。

### C22 · 对比度（浅色 / 深色两套主题都要过）

**验收动作**

1. 主题切浅色，跑下面的脚本；再切深色，重跑一遍：
   ```js
   const lum = c => { const f = x => { x/=255; return x<=0.03928 ? x/12.92 : ((x+0.055)/1.055)**2.4 }; return 0.2126*f(c[0])+0.7152*f(c[1])+0.0722*f(c[2]) };
   const parse = s => (s.match(/[\d.]+/g)||[0,0,0]).map(Number);
   const bgOf = el => { for (let n = el; n; n = n.parentElement) { const c = parse(getComputedStyle(n).backgroundColor); if (c[3] === undefined || c[3] > 0) return c } return [255,255,255] };
   const cr = (a,b) => { const [x,y] = [lum(a), lum(b)]; return ((Math.max(x,y)+0.05)/(Math.min(x,y)+0.05)).toFixed(2) };
   const bad = [];
   for (const el of document.querySelectorAll('.lw-root *')) {
     const txt = [...el.childNodes].filter(n => n.nodeType === 3 && n.textContent.trim()).map(n => n.textContent.trim()).join('');
     if (!txt) continue;
     const r = +cr(parse(getComputedStyle(el).color), bgOf(el));
     if (r < 4.5) bad.push([el.className || el.tagName, txt.slice(0, 18), r]);
   }
   console.table(bad);
   ```
2. 单独确认 `::placeholder`（打开「添加来源」面板，取输入框伪元素色）。

**期望**：两套主题下 `bad` 都是空数组（正文与占位 ≥4.5:1）。特别地，**不许**出现 `--dsw-alias-label-tertiary`（浅色 3.71:1）或 `--dsw-alias-state-success-primary`（浅色 2.28:1）当文字色。

**实测结果（2026-10-02，3083，取色 + WCAG 计算；脚本 `dev/_shots/fresh/contrast.mjs`）**

| 主题 | 节点数 | 最小对比度 | 失败数 |
|---|---|---|---|
| 深色（午夜黑） | 68 | **6.346** | **0** |
| 浅色（干净明亮） | 68 | 3.124 | **5** |

浅色那 5 个失败**全部是同一类**：`.lw-btn.lw-on`（年 / 轮次）、`.lw-chip.lw-on`（本机 / rocs）、`.lw-btn.lw-primary`（更新）。

> **根因与归属（环境限制，非 LogWiki 回归）**
> 皮肤 `mist`（干净明亮）把 `--dsw-alias-brand-primary` 覆盖成 **`#2196f3`**，而配对的
> `--dsw-alias-label-primary-foreground` 仍是**白色** → 白字压蓝底 = **3.124:1**。
> 午夜黑下品牌色是 `#7c8cff` + 深字 → **6.346:1**，反而合格。
> **在原生 token 下这一对是 18.90:1（浅）/ 18.08:1（深）**——`DESIGN.md` 里的对比度数字都是原生值。
> 这是**第三方皮肤覆盖令牌**导致的，**整机所有 DSH 按钮同理**，不是本插件的回归；判为**已知环境限制、不阻塞**。
> 本插件自身可控的部分（正文 / 占位 / 元信息 / 标签）两套主题下 **0 失败**。

**证据形式**：`dev/_shots/fresh/_textdump-{light,dark}.json` + `contrast.mjs` 输出；截图 `docs/screenshots/ui-year-heatmap-light.png`、`ui-year-heatmap-dark.png`。

### C23 · 响应式断点（含 900px 边界的实测口径）

> **口径更正（2026-10-02）**：本项原先写作「窄窗（**≈900px**）下…指标分段退回 select」，把 900 当成了断点内侧。
> 实测**正好 900px 时指标仍是分段控件**，**880px 才退回 `SELECT`** —— 这与 `DESIGN.md §2.9` 写的
> 「**<900px**」完全一致，实现没有跑偏，是原措辞把边界写糊了。**现按 `<900px` 表述，并把 900 / 880 两档都记为必测。**

**验收动作**：窗口宽度依次 **1440 / 1000 / 900 / 880 / 640**，每档跑：

```js
const L = document.querySelector('.lw-ledger');
const m = document.querySelector('[aria-label=指标]');
console.log({ w: innerWidth,
  ledger: L ? [L.offsetWidth, L.offsetParent?.className] : null,
  metricTag: m?.tagName,
  monthAxis: !!document.querySelector('.lw-heat-months'),
  wdCol: !!document.querySelector('.lw-wdcol'),
  legend: !!document.querySelector('.lw-cell-legend'),
  cell: document.querySelector('.lw-cell')?.getBoundingClientRect().width });
```

**期望（2026-10-02 实测值）**

| 宽度 | 台账栏 | 指标控件 | 月份轴/星期栏/图例 | 格子 | 横向溢出 |
|---|---|---|---|---|---|
| 1440 | 右栏，`width === 216` | 分段 | 都在 | **13.66** | 无 |
| 1000 | 退成主区**下方**横带 | 分段 | 都在 | `(8,22]` | 无 |
| **900** | 下方横带 | **分段（`DIV`）** | 都在 | **11.78** | **无** |
| **880** | 下方横带 | **`SELECT`** ← 断点在这里 | 都在 | **11.41** | 无 |
| 640 | **不存在** | `SELECT` | **三者全部隐藏** | **8.00**（触底） | **有**（`scrollWidth 580 > clientWidth 545`） |

**证据形式**：`docs/screenshots/ui-narrow-900-dark.png`、`ui-narrow-640-dark-EXTRA.png`；五档 `console.log` 输出。

### C24 · 零接口变更 + 中文文案 + 隐私

**验收动作**

1. 语法：`node --check dsh-logwiki/lib/client.js` → exit 0。
2. 端点数复算（必须仍是 22）：
   ```powershell
   node -e "const t=require('fs').readFileSync('dsh-logwiki/lib/index.js','utf8');const n=(t.match(/routes\.set\('/g)||[]).length;console.log('routes = '+n);if(n!==22)process.exit(1)"
   ```
3. 运行时请求路径集合没变（打开页面并点一圈）：
   ```js
   console.log([...new Set(performance.getEntriesByType('resource').map(e => e.name.replace(location.origin,'').split('?')[0]).filter(p => p.startsWith('/api/dsh-logwiki')))].sort())
   ```
4. 文案中文：在 `.lw-root` 里扫可见文本，去掉白名单（版本号 / `Token` / `SSH` / `WSL` / `DSH` / `DSH_HOME` / 日期时间 / 纯数字）后不应有连续 ≥2 个拉丁字母。
5. 隐私（不写盘符字面量，Windows 用户目录用运行时拼装，避免自证）：
   ```powershell
   node -e "const fs=require('fs');const bs=String.fromCharCode(92);const re=new RegExp('^[A-Za-z]:'+bs+bs+'Users','m');for(const f of ['docs/DESIGN.md','docs/MANUAL-CHECKLIST.md','README.md','README.zh-CN.md','docs/OVERVIEW.md']){const t=fs.readFileSync(f,'utf8');const b=re.exec(t);if(b)throw new Error(f+': '+b[0])};console.log('privacy ok')"
   ```

**期望**：1–5 全部通过；端点集合 ⊆ 第 0 节列出的 22 个；页面无英文残留（专有名词除外）；文档无盘符/用户名字面量。

**证据形式**：五段命令输出（贴进本节）+ `docs/screenshots/ui-day-ledger-dark.png`（文案全中文、无英文残留的样例页）。


## D. L2 正式安装（3080，通过 L1 后）

| # | 项 | 预期 |
|---|---|---|
| D1 | 把同一行 insert 写进 `$DSH_HOME\profiles\web\cordis.patch.yml`（或 `dsh plugin --profile web add`） | 文件内出现 `id: logwiki` |
| D2 | 挂载复验 | `--dump-config` 出现 `- id: logwiki` |
| D3 | **你**重启 3080（按既有约定我不擅自动它；你说一声我也可以代劳）→ `Ctrl+Shift+R` | 页面正常 |
| D4 | 在 3080 复跑 A 段 + C 段清单 | 同 L1 结果 |
| D5 | **确认桌面端 19387 全程未受影响** | 会话未断、无报错 |

## E. 红线核对（任何阶段）

| # | 项 | 预期 |
|---|---|---|
| E1 | 全程未重启/kill 19387、3080 | 进程 PID 59360 / 70384 始终在 |
| E2 | 未向会话日志追加任何事件 | 插件只写 `storage` KV；无 `session/append` 调用 |
| E3 | LLM 调用省略 `purpose` / `sessionId` | 自检断言（线 B D 段） |
| E4 | 未使用 `source.kind='plugin'` | 只用 `plugin:dsh-logwiki` |
| E5 | 工作区标签在 `workspaceRegistry` 缺失时退回 basename | `/day` 里 workspaceLabel 是 `DSH-LogWiki` 这类短名，不是完整路径 |

---

## 验收结果记录

> **读这一节前先看这张表**：`accept-l1.mjs` 的断言条数**随套件演进而增长**，所以历史记录里
> 29 / 33 / 36 / 44 / 45 这些数字**不是互相矛盾，而是不同日期、不同实例、不同套件版本**的结果。
> 之前这几种数字散落在本文与 `README` 里却没有任何版本说明，看起来像自相矛盾 —— 已补上口径。

| 日期 | 实例 | 模式 | 结果 | 说明 |
|---|---|---|---|---|
| 2026-10-01 | L1 `3082` | 只读（`--no-refresh`） | 29/29 | 当时的套件只有 29 条断言 |
| 2026-10-01 | L2 `3080` | 只读 | 29/29 | 同上 |
| 2026-10-01 稍晚 | L2 `3080` | 只读 → 完整 | 33/33 → 36/36 | 补了守恒不变量等断言 |
| 2026-10-01 晚 | 桌面端 `19387` | 只读 | 45/45 | 工具 schema 修复后复验 |
| **2026-10-02** | **UI 精修验证实例 `3083`** | **只读** | **45/45，exit=0** | **当前口径**（UI 精修后、真实数据快照库 `dsh_logwiki_uicheck`） |

**当前口径 = `45/45`。** 以后引用验收数字请带上日期 + 实例，避免再次出现"同一份文档里 44 和 45 并存"。

### A. 自动化（2026-10-01 初次交付）
```
$ node scripts/accept-l1.mjs http://127.0.0.1:3082 --no-refresh   →  29/29，exit=0   （L1，真实数据）
$ node scripts/accept-l1.mjs http://127.0.0.1:3080 --no-refresh   →  29/29，exit=0   （L2，真实 web 端）
```
关键数据（`/state` 与界面数字逐字吻合）：
```
totals: 652 回合 / 25 会话 / 25 条目；7 个活跃日（2026-09-25 → 2026-10-01）
scan: done=true, truncated=true, pending=697（剩余历史待「更新」续跑）
degradedDays: 0（无降级，摘要全部由 LLM 生成）
```
> **后补的 6 条守恒不变量**：发现「工作区卡 turns/sessions 恒为 0」这个真实缺陷时，旧断言修前修后都是全绿——说明套件缺「部分之和 == 整体」的检查。已补齐：
> `Σ各天 turns == totals.turns`、`Σ各天 entries == totals.entries`、`Σ工作区 turns/sessions/entries == 当天合计`、`条目卡总数 == 当天 entries`、`每个工作区至少 1 条条目`。
> **判别力已验证**：修复前的 `/day` 曾返回工作区 `{turns:0,sessions:0}` 而当天合计 `355`，`0 ≠ 355` → 新断言会 FAIL。

### B. 静态 —— ✅
8 个 lib 文件 `node --check` 全过；`verify-extract.mjs` **159/0**；`verify-prompts.mjs` **103/0**；`--dump-config` 挂载证据齐；共享 profile 原有行（overleaf / fantian-workbench）完好。

### C. 界面与交互 —— ✅ 真实数据可视证据
- `docs/screenshots/l1-real-01-heatmap.png`：热力图 7 个绿格 + 「2026 年 · 652 轮次 · 7 个活跃日」
- `docs/screenshots/l1-real-02-day.png`：三层卡片（来源「本机」→ 工作区「DSH」「DSH-LogWiki」→ 条目，含标签/会话数/编辑删除/`已手改` 徽章）
- `docs/screenshots/l2-3080-heatmap.png`：**真实 web 端 3080** 上的同一界面
- 交互动过：编辑条目 → `POST /entry` → 重读确认 `edited=true` → 复原（脚本自动完成）
- **作废**：早期 `c-0*.png` 是 CDP 注入 mock 渲染的，**不算真实数据证据**

### D. L2 正式安装 —— ✅
- insert 行已写入 `$DSH_HOME\profiles\web\cordis.patch.yml`：**before 1749 行 → after 1780 行**，出现 `- id: logwiki`（line 1757）。
- **3080 已重启**（旧 pid 70384 → 新 pid 16240，分离进程）。
- `GET http://127.0.0.1:3080/api/dsh-logwiki/ping` → **HTTP 200**，五个模块全 ✓。
- 3082 / 3081 已关闭（单一 KV 写者）。

### E. 红线核对 —— ✅
| 项 | 结果 |
|---|---|
| 桌面端 19387 | **pid 59360 全程未动**（桌面端走 `profiles/desktop`，与 `profiles/web` 天然隔离——由进程命令行确认） |
| 未向会话日志追加事件 | 插件只写 `storage` KV |
| LLM 调用省略 `purpose`/`sessionId` | 线 B 自检 D 段断言 |
| 未使用 `source.kind='plugin'` | 只用 `plugin:dsh-logwiki` |

> ⚠️ **口径更正（2026-10-01 稍晚，工具 schema 修复）**：上表 E1/D5 的"19387 全程未动"是**当时那次 L1/L2 验收期间的保护性约定**，不是长期红线。
> 同日发现桌面端报 `Invalid schema … got 'type: null'`，根因是 `tools.register` 不校验 `parameters`、坏 schema 被原样发进模型请求；
> 而**插件是进程内加载**——当时运行的桌面端主进程（PID 40740，启动于 20:34:02）早于修复文件（21:07:30），内存里仍是旧定义。
> 因此**必须重启 19387 才能让修复生效**，本轮已为此外加重启（新宿主 PID 34824，Electron 主窗口 PID 48916，均启动于 22:44）。
> 重启后复验：`accept-l1.mjs http://127.0.0.1:19387` → **45/45，exit=0**；`/health.tools.inputFingerprints` 与仓库侧独立复算逐字相同；UI 真实回合 `1 轮 2 步`，全程无 schema 报错。
> 证据见 `DEVLOG.md`「工具输入 schema 修复（2026-10-01）· 桌面端（19387）验收」。
> 现口径：**除"让插件加载新代码"这类确有必要且已说明的重启外，不得擅动 19387**；本插件在 3080 与 19387 上同时启用、共用一份 KV 的问题仍未解决（见下）。

### C-CLICK. 必须**真的点一遍**的交互（HTTP 层测不到，需人工或浏览器自动化）

> **编号说明**：这一节原先也叫「C2」，与上面 C 表里的 `C2` 条目（左栏图标激活态）**重名**，
> 造成"看 C2 不知道指哪个"的歧义。现改名为 **`C-CLICK`**；`README` 里的指引同步更新。

> **为什么单列**：`accept-l1.mjs` 只打 HTTP 端点，**测不到"按钮点了有没有反应"**。
> 2026-10-01 就栽在这里：`‹ / ›` 周期导航按钮的 `title` 与 `disabled` 状态全对，我也据此判定"已验证"，
> 但**它点了真没反应**——因为"周期跟随选中日"的 effect 会把手动跳转立刻改回去。
> **教训：断言按钮的"存在/文案/禁用态"不等于验证了它的行为；必须点击并断言状态真的变了。**

| # | 操作 | 期望 | 结果 |
|---|---|---|---|
| 1 | 点任意一天 → 点「周总结」 | 周期 = **该天所属周**（不是今天那周） | ✅ 2026-09-25 → W39 |
| 2 | 再点「月总结」 | 周期 = **该天所属月** | ✅ 2026-09-25 → 2026-09 |
| 3 | 点头部 `‹` | 周期**真的跳到上一周并停住**（不能被拉回） | ✅ W40 → W39 |
| 4 | 点头部 `›` | 周期真的跳到下一周 | ✅ W39 → W40 |
| 5 | 在某周期下**再点另一天** | 面板**自动跟随**到该天所属周期 | ✅ 点 09-25 → W40 自动变 W39 |
| 6 | 点「回到本周 / 回到本月」 | 周期回到当前周/月，且**日详情自动关闭**，该按钮消失 | ✅ |
| 7 | 点「生成」 | 出现进度、成功后渲染卡片列表（标题 + 总览 + N 张卡） | ✅ |

### 已知问题（截至 2026-10-02，如实列出）

1. **历史未回填完**：`scan.pending` 仍不为 0，当前视图只覆盖最近一段时间。点「更新」继续填，每轮按 `scan.maxNewPerRun` 分批。
2. **二期（M9–M11）已完成并验收** —— 远程来源登记 / SSH 快速通道同步 / 来源隔离展示三件都已落地并有实测记录。
   （本条目此前标为"未开始"，已按现状更正；现状见 `README` 的 Roadmap 与 `DEVLOG.md` 的远程来源小节。）
3. **`promptPreview` 受注入块污染**：顶层会话首条 user 消息常是 meow-memory 的 `"===== 长期记忆 ====="`，按现行契约确实该采信，但会拉低摘要质量。建议做成可配置 skip-patterns。
4. **运行期阻塞**：读超大日志时事件循环会被占住数十秒，期间界面/探针会无响应（非崩溃）。
5. **第三方皮肤会覆盖设计令牌**（环境限制，非本插件缺陷）：
   - `dsh-dream-skin` 的「午夜黑」**强制深色**，DSH 内置「外观 → 浅色」点了不生效；本机**无法验证原生浅色主题**。
   - 皮肤把 `--dsw-alias-bg-base` 覆盖成 **10% 半透明**：在「深壁纸 + 浅色主题」组合下组件根面会合成成 `#3b3b3e` 而文字是 `#0f1b33`，近乎不可读。
   - 皮肤把 `--dsw-alias-brand-primary` 覆盖成 `#7c8cff`（午夜黑）/ `#2196f3`（干净明亮），而配对的 `--dsw-alias-label-primary-foreground` 仍是白色 → **品牌底白字只有 3.124:1**，整机所有 DSH 按钮同理。
   - **判为已知环境限制、不阻塞**；`DESIGN.md` 里的对比度数字都是**原生 token** 下的值。

---

## 签字

### 交付时状态（2026-10-01）
- **实例**：`19387` 桌面端 **pid 59360（全程未动）**；`3080` 真实 web 端运行 LogWiki。
- **验收命令**：
  - 对生产实例（安全、只读、幂等）：`node scripts/accept-l1.mjs http://127.0.0.1:3080` → **33/33，exit=0，约 0.3s**
    （跑前后对 `storages/dsh_logwiki.json` 取 sha256 未变，已实证幂等）
  - 完整模式（会写数据，仅限专用实例）：加 `--mutate --refresh` → **36/36**
- **需求 7（周/月简报）已全部验证**：周 11/10 条、月 9/8 条，四条全落在 8–12 区间；缓存复读不重算；「交给智能体」提示词含 `logwiki_write_digest`。
- **数据现状**：视图显示 **7 个活跃日（2026-09-25 ~ 10-01）/ 25 条条目**。首次回填是**分批渐进**的——点「更新」会继续往更早的时间补（每次约 300 个会话、约 25 分钟）。
  - ⚠️ 回填期间读超大日志会让事件循环短暂占住，**页面可能发顿**，属预期行为（`/state` 会等到循环让出才返回）。
  - 注：中途重启会中止回填，已落库的会话会保留，但 `days` 聚合只在轮末重算——所以**视图可能暂时落后于已抓取的会话数**，下次「更新」会用全量重算补齐。

- [x] L1 全绿（A 33/33 只读 + B 静态门 + C 真实数据截图），证据见 `DEVLOG.md`
- [x] L2 在 3080 复验通过（D，33/33 只读 / 36/36 完整）
- [x] 红线核对通过（E）
- [ ] **用户确认验收通过** —— 在此之前开发任务不终止

签字时间：__________
