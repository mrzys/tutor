---
name: ollama-ui-design
version: "1.0"
updated: 2026-09-28
purpose: 面向 Agent 的 UI 实现规范 —— 读本文档即可产出符合该系统的前端代码
stack: 任意（HTML/CSS/React/Vue），示例为原生 CSS 变量 + class 命名
icon: Lucide (24x24 grid, stroke-only)
font_display: SF Pro Rounded → PingFang SC → HarmonyOS Sans SC → Source Han Sans SC → Microsoft YaHei
font_body: system-ui / PingFang SC / Microsoft YaHei
font_mono: ui-monospace / JetBrains Mono / Menlo
---

# Ollama UI 设计规范（Agent 执行版）

> 这是一份**给 Agent 读**的规范，不是给人读的设计说明。
> 所有规则都是可判定、可直接翻译成代码的。遇到本文档未覆盖的情况，回到第 1 节的硬约束做判断。

---

## 0. Agent 使用说明

**读法顺序**：第 1 节（硬约束）→ 第 2 节（token）→ 第 3 节（中文排版）→ 按需查第 4–8 节 → 交付前跑第 9 节清单。

**规则优先级**（冲突时按此顺序）：
1. 第 1 节硬约束
2. 具体组件规范
3. Token 表
4. 示例截图／预览文件

**标记含义**：
- `MUST` 必须，违反即为错误
- `MUST NOT` 禁止，出现即为错误
- `SHOULD` 建议，偏离需在代码注释说明理由
- `MAY` 可选

**参考实现**：`ollama-ui-preview.html`（同目录工程内）是本文档的可运行样例，不确定某个组件的成品长什么样时以它为准。

---

## 1. 硬约束（10 条，MUST / MUST NOT）

| # | 约束 |
|---|---|
| 1 | 画布 **MUST** 是纯白 `#ffffff`，全页无表面交替、无色块分段、无渐变、无大气层背景 |
| 2 | 品牌色 **MUST** 只有纯黑 `#000000`。MUST NOT 出现任何品牌色、主题色、渐变色 |
| 3 | 一切可交互元素 **MUST** 用胶囊 `{rounded.full}`（9999px）；容器 **MUST** 用 `{rounded.lg}`（12px）。MUST NOT 出现 8px 按钮或 9999px 卡片 |
| 4 | **MUST NOT** 使用 box-shadow 做层级提升。层级只有两种手段：1px 发丝线边框、或反相为深色面 |
| 5 | 深色面 `{surface-dark}` **MUST** 每屏至多出现一次，且 **MUST** 绑定「当前可购／当前主推」的对象，MUST NOT 固定给最贵档位 |
| 6 | 装饰性插画 **MUST** 只有 llama 吉祥物与线条锁图标。MUST NOT 引入 3D 渲染、emoji、装饰性图形 |
| 7 | 正文色 **MUST** `#525252`；`MUST NOT` 使用 `#a3a3a3` 承载任何需要阅读的文字 |
| 8 | 中文字体栈 **MUST** 显式声明 PingFang SC / Microsoft YaHei，MUST NOT 让中文回退到宋体 |
| 9 | **MUST NOT** 对中文使用 `font-style: italic`、字重 300、`text-transform: uppercase` |
| 10 | 动效 **MUST** 只作用于 `opacity` / `transform` / `background-color` / `border-color`。MUST NOT 动 `width` / `height` / `top` / `box-shadow` |

---

## 2. Tokens

### 2.1 颜色

```css
:root{
  /* 表面 */
  --canvas:#ffffff;          /* 页面底色，占 95% 以上面积 */
  --surface-soft:#fafafa;    /* 搜索框、代码块、次要芯片 */
  --surface-dark:#171717;    /* 唯一反相面，每屏 ≤1 次 */
  --hairline:#e5e5e5;        /* 1px 边框、分割线 */
  --hairline-strong:#d4d4d4; /* 需要更强分离时 */

  /* 文字四级 */
  --ink:#000000;      /* 21:1  标题、按钮文字、价格、强调 */
  --body:#525252;     /* 7.8:1 正文（默认） */
  --mute:#737373;     /* 4.7:1 次要说明、元信息、占位符 */
  --faint:#a3a3a3;    /* 2.5:1 仅装饰与终端注释，禁止承载正文 */

  --on-dark:#ffffff;
  --on-dark-mute:rgba(255,255,255,.72);

  /* 语义色（仅这四处允许彩色） */
  --danger:#dc2626;   /* 4.8:1 校验失败、配额耗尽 */
  --success:#15803d;  /* 5.0:1 成功、diff 新增 */
  --warning:#b45309;  /* 5.0:1 额度将尽、可执行脚本、权限审批 */
  --focus:#3b82f6;    /* 3.7:1 焦点环（实心，禁止半透明） */
}
```

**对比度规则**
- 正文 MUST ≥ 7:1（中文笔画密度高于拉丁字母，4.5:1 的 AA 底线对中文不够）
- 次要文字 MUST ≥ 4.5:1
- `--faint` MAY 用于图标、终端注释、禁用态；MUST NOT 用于任何需要阅读的文本
- 焦点环 MUST 用实心 `#3b82f6`，半透明蓝在白底仅 1.84:1，不达标

### 2.2 字阶（中文实测值）

| Token | 字号 | 字重 | 行高 | 字距 | 用途 |
|---|---|---|---|---|---|
| `display-xl` | 44px | 600 | 1.25 | .01em | 首屏标题，全站 **MUST** 只出现一次 |
| `display-lg` | 30px | 600 | 1.30 | .01em | 页面级标题、价格数字 |
| `heading-lg` | 24px | 600 | 1.40 | .01em | 区块标题 |
| `heading-md` | 20px | 600 | 1.50 | 0 | 卡片标题、档位名 |
| `heading-sm` | 18px | 500 | 1.55 | 0 | 小标题、FAQ 问句 |
| `body-md` | 16px | 400 | **1.75** | 0 | 正文默认 |
| `body-sm` | 14px | 400 | **1.70** | 0 | 表格、列表、说明 |
| `body-sm-strong` | 14px | 500 | 1.70 | 0 | 按钮文字、导航链接 |
| `caption` | 13px | 400 | 1.65 | 0 | 元信息（**最小字号，12px 已废弃**） |
| `code-md` | 16px | 400 | 1.50 | 0 | 安装命令 |
| `code-sm` | 14px | 400 | 1.70 | 0 | 代码块、终端输出 |

```css
body{font-size:16px;line-height:1.75;letter-spacing:0}
h1,h2,h3,h4{font-weight:600;line-height:1.35;letter-spacing:.01em}
```

### 2.3 间距与布局

```css
--s-2:2px; --s-4:4px; --s-8:8px; --s-12:12px; --s-16:16px;
--s-24:24px; --s-32:32px; --s-48:48px;
--s-section:88px;        /* 区块垂直节奏：整页唯一的“大”间距 */
--nav-h:56px;            /* 顶部导航，sticky */
--sidebar-w:224px;       /* 侧边栏 */
--col-read:720px;        /* 阅读型内容列 */
--col-app:1120px;        /* 应用型内容列 */
```

- 区块之间 **MUST** 用 `--s-section`（88px）；MUST NOT 用装饰性分割线或色块代替留白
- 响应式收缩：88px → 64px（平板）→ 48px（移动）
- 卡片内边距 MUST 为 `--s-32`；紧凑卡片 MAY 用 `--s-24`；列表行用 `--s-16`

### 2.4 圆角

| Token | 值 | 用途 |
|---|---|---|
| `rounded.none` | 0 | 导航、页脚、行分割线 |
| `rounded.sm` | 6px | 行内代码芯片、扩展名标签 |
| `rounded.md` | 8px | 下拉面板（**唯一**使用处） |
| `rounded.lg` | 12px | 卡片、终端、代码块、弹层 |
| `rounded.full` | 9999px | 按钮、输入框、搜索、芯片、终端圆点 |

### 2.5 动效

```css
--dur-instant:80ms;   /* 按下、图标位移 */
--dur-fast:120ms;     /* hover、背景/边框变化（最常用） */
--dur-base:200ms;     /* 展开收起、Toast 入场 */
--dur-slow:320ms;     /* 弹层、抽屉、卡片入场 */
--ease-out:cubic-bezier(.2,.8,.2,1);
--ease-spring:cubic-bezier(.34,1.4,.64,1);   /* 仅用于位移 */
```

| 场景 | 参数 | 效果 |
|---|---|---|
| 按钮 hover | 120ms | 背景色变化，**不位移** |
| 按钮按下 | 80ms | `scale(.97)` |
| 外链图标 hover | 120ms | `translate(1.5px,-1.5px)` |
| 折叠展开 | 200ms ease-out | 透明度 + 上移 4px |
| Toast 入场 | 180ms | 底部上移 6px + 淡入 |
| 弹层/抽屉 | 320ms spring | 唯一允许大位移处 |
| 流式光标 | 1s steps(2) | 7×16px 黑块闪烁 |
| 思考中三点 | 1.2s 依次延迟 .15s | 上下 4px，透明度 .45→1 |
| 骨架脉冲 | 1.4s | **仅透明度，禁止扫光** |

```css
@media (prefers-reduced-motion: reduce){
  *,*::before,*::after{animation-duration:.01ms!important;transition-duration:.01ms!important}
  /* MUST 换成“不动的等价状态”，不是直接关掉 */
  .sk{animation:none!important;opacity:1!important}
  .stream-caret{animation:none!important;opacity:1!important}
}
```

### 2.6 图标（Lucide）

```css
.icn{width:16px;height:16px;stroke-width:1.75;color:currentColor;flex:0 0 auto;display:block}
.icn-12{width:12px;height:12px;stroke-width:2}
.icn-14{width:14px;height:14px;stroke-width:1.75}
.icn-20{width:20px;height:20px;stroke-width:1.5}
.icn-24{width:24px;height:24px;stroke-width:1.5}
```

| 规则 | 说明 |
|---|---|
| 尺寸 | 只允许 12 / 14 / 16 / 20 / 24 五档，MUST NOT 用奇数尺寸 |
| 描边 | 随尺寸反向补偿：24→1.5，20→1.5，16→1.75，14→1.75，12→2 |
| 颜色 | MUST `currentColor`，MUST NOT 单独给图标上色 |
| 填充 | MUST 用 stroke 版；MUST NOT 用 fill 版图标 |
| 中文混排 | MUST `translateY(2~3px)` 对齐基线；用 `align-items:center` 会偏高像上标 |
| 触控 | 图标按钮触控区 MUST ≥ 32×32（视觉尺寸可更小） |
| 禁用 | MUST NOT 混用 emoji 当图标 |

**文件类型映射**（新增类型 MUST 走此表，MUST NOT 临场挑图标）：

| 类型 | Lucide | 扩展名 |
|---|---|---|
| 文档 | `FileText` | pdf doc docx txt |
| 表格 | `Sheet` | xls xlsx csv |
| 演示 | `Presentation` | ppt pptx key |
| 图片 | `Image` | png jpg svg webp |
| 代码 | `FileCode` | py js ts go json yaml sh |
| 压缩包 | `Package` | zip tar gz 7z |
| 音视频 | `Music` / `Film` | mp3 wav mp4 mov |
| 数据 | `Database` | db sqlite parquet |
| 兜底 | `File` | 其他（**永不留空**） |

可执行文件（`.sh` `.bat` `.ps1` `.exe`）MUST 叠加警示态：琥珀边框 `#fed7aa` + 图标变 `--warning`。

---

## 3. 中文排版（12 条 MUST）

```css
body{
  font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","HarmonyOS Sans SC",
              "Source Han Sans SC","Noto Sans CJK SC","Microsoft YaHei",system-ui,sans-serif;
  line-height:1.75;
  letter-spacing:0;                 /* 正文不加字距 */
  word-break:normal;                /* 禁止 break-all */
  overflow-wrap:break-word;
  text-spacing-trim:space-first;    /* 标点挤压，不支持的浏览器自动忽略 */
  hanging-punctuation:allow-end;
}
```

1. 行高：正文 1.75、小字 1.70、标题 1.30–1.40（西文 1.5 用在中文会挤成砖墙）
2. 字距：正文 0；≥24px 标题 `+.01em`；MUST NOT 给小字号正文加字距
3. 字重：只用 400 / 500 / 600。MUST NOT 用 300（微软雅黑无 Light，会合成糊字）
4. MUST NOT `font-style:italic`；需要强调时改用字重或颜色
5. MUST NOT `word-break:break-all`；MUST NOT `text-transform:uppercase`
6. 中西混排：拉丁词与数字两侧留 `0.05em`，并换用拉丁字体
7. 数字与价格 MUST `font-variant-numeric:tabular-nums`，表格内右对齐
8. 最小字号 13px（12px 已废弃）
9. 标点 MUST NOT 出现在行首
10. 标题字体 `SF Pro Rounded` 不含中文字形 —— 中文标题实际由 PingFang / 微软雅黑接管，这是已知且可接受的妥协
11. 中文段落 MUST 左对齐，MUST NOT 两端对齐（Web 上会造成字距空洞）
12. 按钮中文 MUST NOT 少于 2 字；按钮用 `min-width` 避免过窄

中西混排写法：
```html
在<span class="lat">Ollama</span>上运行<span class="lat">qwen3.5</span>，需要<span class="lat">11GB</span>显存
```
```css
.lat{margin-inline:.05em;font-family:var(--font-latin)}
```

---

## 4. 组件

### 4.1 按钮

```css
.btn{height:40px;padding:0 20px;min-width:64px;font-size:14px;font-weight:500;
     border-radius:9999px;border:1px solid transparent;display:inline-flex;
     align-items:center;justify-content:center;gap:8px;cursor:pointer;white-space:nowrap}
.btn-primary{background:#000;color:#fff}
.btn-secondary{background:#fff;color:#000;border-color:var(--hairline-strong)}
.btn-on-dark{background:#fff;color:#000}      /* 深色面上反相 */
.btn-ghost{background:transparent;color:#000;padding:0 12px}
.btn-sm{height:32px;padding:0 14px;font-size:13px}
.btn-lg{height:48px;padding:0 28px;font-size:16px}
.btn-touch{height:44px}                        /* 触控 / AAA 场景 */
.btn:disabled{background:#fafafa;color:var(--mute);cursor:not-allowed}
```

| 规则 | 说明 |
|---|---|
| 高度 | 40px（满足 WCAG 2.2 AA 的 24×24）；触控场景 MUST 用 44px |
| **MUST NOT** | 声称 40px 满足 AAA 44×44 —— 不满足；需要 AAA 就提到 44px |
| 变体 | `-primary` `-secondary` `-on-dark` `-ghost` `-danger`，加减尺寸用 `-sm` `-lg` `-touch` |
| 加载态 | MUST `disabled` 且保留原宽度（`min-width` 锁定），MUST NOT 让布局跳动 |
| 数量 | 每屏主行动唯一；导航 Download、并列选项组（定价卡 CTA）不计入 |

### 4.2 输入框与表单

```css
.input{height:40px;padding:0 16px;width:100%;font-size:16px;color:var(--ink);
       background:#fff;border:1px solid var(--hairline);border-radius:9999px}
.input:focus{outline:none;border-color:#000;box-shadow:0 0 0 3px rgba(59,130,246,.28)}
.input.is-error{border-color:var(--danger)}
textarea.input{height:auto;padding:10px 16px;border-radius:12px;line-height:1.7}
.label{font-size:14px;font-weight:500;color:var(--ink);margin-bottom:4px;display:block}
.help{font-size:13px;color:var(--mute);margin-top:4px;line-height:1.65}
.err{font-size:13px;color:var(--danger);margin-top:4px;display:flex;gap:6px}
```

- 多行输入 MUST 用 12px 圆角（胶囊在超过一行时视觉怪异）
- 错误提示 MUST 同时给出「原因 + 下一步」，只报错不给出路的是不合格提示
- 占位符用 `--faint`，MUST NOT 用占位符代替 label

### 4.3 搜索框 / 安装片段 / 命令标签

三个组件语义不同但都是灰胶囊，**MUST 用边框区分**：

| 组件 | 背景 | 边框 | 高度 |
|---|---|---|---|
| `search-pill` | `--surface-soft` | 无（focus 时出现） | 36px |
| `install-snippet` | `--surface-soft` | **1px hairline** | 56px |
| `command-tag` | `--surface-soft` | 无 | 28px |

复制按钮交互：点击后整枚按钮反相为黑底白字、文案改「已复制」，1.6s 后复原。这是全系统 MAJOR 允许的瞬时状态反馈，因为它发生在用户刚操作的那个元素上。

### 4.4 卡片

```css
.card{background:#fff;border:1px solid var(--hairline);border-radius:12px;padding:32px}
.card-dark{background:#171717;border-color:#171717;color:#fff}
```
- MUST NOT 用阴影抬升卡片
- 深色卡每屏 MUST ≤ 1 个

### 4.5 表格

```css
table{width:100%;border-collapse:collapse;font-size:14px;line-height:1.7}
th{text-align:left;font-weight:600;font-size:13px;padding:10px 12px;
   border-bottom:1px solid var(--hairline-strong)}
td{padding:12px;border-bottom:1px solid var(--hairline);color:var(--body)}
td.n,th.n{text-align:right;font-variant-numeric:tabular-nums}  /* 数字列 */
```
- MUST NOT 加外框，只有横向发丝线
- 数字列 MUST 右对齐 + 等宽数字
- 空数据 MUST 走空状态组件，MUST NOT 渲染空表头

### 4.6 其他

`.tabs` / `.tab`（选中态反相黑）· `.switch`（40×24，开启纯黑）· `.dd` `.dd-menu`（8px 圆角）· `.badge` `.badge-warn` `.badge-ok` `.badge-dark` · `.toast`（深色胶囊，右下角）· `.sk`（骨架，仅透明度脉冲）· `.empty`（虚线边框）· `.alert-danger` · `.pager` · `.crumb`（13px，无下划线，hover 才有）

---

## 5. 代码块渲染

五种形态，全部 MUST 用 `--font-mono`。

### 5.1 源码块

结构：`bar（文件图标 + 文件名 + 语言标签 + 复制/折叠）` + `pre`（可选行号）

```css
.codeblock{border:1px solid var(--hairline);border-radius:12px;overflow:hidden}
.cb-bar{display:flex;align-items:center;gap:8px;padding:8px 10px 8px 14px;
        border-bottom:1px solid var(--hairline);min-height:40px}
.codeblock pre{margin:0;padding:16px;overflow-x:auto;font-size:13.5px;line-height:1.75}
.codeblock.ln .ln::before{content:counter(lnum);counter-increment:lnum;
  display:inline-block;width:2em;margin-right:16px;text-align:right;color:var(--faint);user-select:none}
```

### 5.2 语法着色：**单色系**（MUST）

```css
.t-kw{color:var(--ink);font-weight:600}   /* 关键字 */
.t-str{color:var(--body)}                 /* 字符串 */
.t-num{color:var(--ink);font-variant-numeric:tabular-nums}
.t-cm{color:var(--faint);font-style:italic}  /* 注释（拉丁斜体允许） */
.t-pun{color:var(--mute)}                 /* 标点 */
```

**MUST NOT** 引入彩色语法主题 —— 多色高亮会直接破坏黑白灰契约。靠「字重 + 灰阶 + 斜体」三维区分。

### 5.3 diff（唯一允许彩色背景处）

```css
.ln.add{background:#f0fdf4;box-shadow:inset 2px 0 0 var(--success)}
.ln.del{background:#fef2f2;box-shadow:inset 2px 0 0 var(--danger)}
```

### 5.4 工具返回 JSON

超过 20 行 MUST 折叠，保留前 12 行 + 「展开全部（N 行）」。MUST NOT 做语法折叠树（那是编辑器职责）。

### 5.5 终端会话

- `$` 提示符与命令 `--ink`，输出 `--body`，注释 `--faint`
- 状态 MUST 用符号（✓ ◐ ✗）而非颜色表达 —— 符号在单色终端里更可靠

### 5.6 行内代码

```css
code.inline{font-family:var(--font-mono);font-size:.92em;background:var(--surface-soft);
            border:1px solid var(--hairline);border-radius:6px;padding:1px 5px}
```
MUST NOT 与胶囊按钮混用：按钮是 9999px，代码是 6px，形状必须可分。

---

## 6. 链接与文件

| 类型 | 样式 | 参数 |
|---|---|---|
| 正文内联 | `--ink` + 1px 下划线 | `text-underline-offset:3px`，hover 加粗到 2px，不改颜色 |
| 外部链接 | 内联 + 14px `ExternalLink` 图标 | 图标默认 `--mute`，hover `translate(1.5px,-1.5px)` 并转黑 |
| 安静链接 | `--body` 灰 + 下划线 | hover 转黑。用于页脚、法务链接 |
| 面包屑 | 13px，`--mute`，无下划线 | hover 才出现下划线 |

**位移方向 MUST 与实际行为一致**：外链↗、下载↓、展开→。

### 文件链接（胶囊式）

MUST 同时具备三件套：**类型图标 + 扩展名标签 + 体积**

```html
<a class="lk-file" href="#">
  <svg class="icn icn-20">…FileText…</svg>
  <span class="fname">模型评测报告</span>
  <span class="fext">PDF</span>
  <span class="fsize">2.4 MB</span>
</a>
```
- `.fext` 用 mono 11px + 1px 边框 + 6px 圆角
- 可执行文件 MUST 加 `.is-exec`（琥珀边框 + 图标变 warning）

### 附件 chip（输入框内）

32px 高胶囊，图标 + 文件名 + 移除按钮（20×20）。移除按钮 MUST 有 `aria-label`。

---

## 7. Agent 界面规范

Agent 页面不是聊天，是**任务执行过程的可视化**。用户必须随时知道三件事：它在想什么、调了什么工具、产出了什么文件。

### 7.1 八条规则

| 元素 | 规则 |
|---|---|
| 思考过程 | **MUST** 默认折叠，只显示标题 + 耗时；**MUST NOT** 做实时打字机（那是在表演思考） |
| 工具调用 | 三态 MUST 可辨：执行中（旋转图标 + 三点跳动）、成功（绿色 ✓ + 耗时）、失败（红边框 + **原始错误原文**） |
| 流式输出 | 光标 7×16px 黑块、1s `steps(2)`；每 `requestAnimationFrame` 至多更新一次 DOM，**MUST NOT** 逐字符 `innerHTML` |
| 权限审批 | MUST 琥珀警示框 + **三个**选项（允许一次 / 本会话始终允许 / 拒绝），MUST NOT 只给「确定」 |
| 产出文件 | MUST 带类型图标 + 体积 + 状态；生成中显示「待生成」而非隐藏 |
| 停止按钮 | 运行期间 MUST 常驻且位置固定，MUST NOT 随消息流滚走 |
| 引用来源 | 编号 chip，点击跳原文，编号与正文角标一一对应 |
| 长输出 | 代码 > 20 行 MUST 折叠，工具返回 > 12 行 MUST 折叠；消息流中 MUST NOT 出现需滚三屏的裸文本 |

### 7.2 布局

```
[顶部导航 sticky 56px]
[会话列表 200px] [消息流 flex] [Artifact 面板 300px]
                 [输入区 composer]
```

### 7.3 输入区

- 附件 chip 行 → 输入框（12px 圆角）→ 工具 chip 行（工具/联网/附件，选中反相黑）
- 右侧常驻：当前模型 + 剩余额度 + 发送按钮
- 运行中输入区 MUST 切换为「停止」

### 7.4 失败态文案

工具失败 MUST 展示原始错误原文，**MUST NOT** 翻译成人话 —— 翻译会丢掉排查必需的信息。可以在原文上方补一行人话解释，但原文必须在。

---

## 8. 页面模板

| 页面 | 结构 |
|---|---|
| 首页 | sticky 导航 → 44px 居中标题 → 56px curl 安装片段 → 特性区（左文右终端）→ 定价摘要 → 隐私条 → 页脚。区块间距 88px，内容列 720px |
| 列表页 | 面包屑 → 页面标题 → 筛选 chips + 搜索 → 表格 → 分页。列宽 1120px |
| 详情页 | 面包屑 → 标题 + 主 CTA → 终端卡 → 参数表 |
| 设置页 | 两栏：表单（左）/ 开关组（右）→ 保存 / 放弃 |
| 计费页 | KPI 卡 ×4 → 明细表（含合计行）→ 增加额度 / 导出 |
| 定价页 | 5 档栅格（≥1280px 5 列 / 1180 3 列 / 640 1 列）。深色卡绑定「当前可购主推档」 |
| Agent 会话 | 见 7.2 |

**响应式**
- 断点：1280 / 1024 / 850 / 768 / 640
- 导航在 768px 转抽屉，但黑色 Download CTA **MUST** 始终可见，MUST NOT 收进菜单
- 搜索框：360px → 240px → 图标 + 全宽浮层
- 首屏标题 44px → 32px（900px）→ 28px（640px）
- 定价栅格 5 → 3 → 2 → 1

**页脚**：链接行 + 法务行（两行分组），13px，1px 上边框，无底色。

---

## 9. 交付前检查清单

**中文排版**
- [ ] 字体栈含 PingFang SC / 微软雅黑，无宋体回退
- [ ] 正文行高 ≥ 1.7，标题 1.3–1.4
- [ ] 无 300 字重、无 italic、无 uppercase、无 `word-break:break-all`
- [ ] 中西混排处有 0.05em 留白
- [ ] 数字用 `tabular-nums` 并右对齐
- [ ] 最小字号 13px
- [ ] 标点未出现在行首

**视觉与 token**
- [ ] 画布纯白，无渐变、无阴影、无装饰插画
- [ ] 交互元素全为 9999px，容器全为 12px
- [ ] 深色面每屏 ≤ 1 个，且绑定当前主推对象
- [ ] 无品牌色、无彩色语法高亮

**无障碍**
- [ ] 正文对比度 ≥ 7:1，次要文字 ≥ 4.5:1
- [ ] `--faint` 未承载任何需阅读文本
- [ ] 焦点环实心 `#3b82f6` / 2px / offset 2px
- [ ] 交互元素 ≥ 24×24（AA），触控 44×44
- [ ] 按钮加载态禁用且保持原宽度
- [ ] `prefers-reduced-motion` 下有「不动的等价状态」

**链接与图标**
- [ ] 每个文件链接有类型图标 + 扩展名 + 体积
- [ ] 可执行文件走警示态
- [ ] 外链有指示图标且目标 `target="_blank" rel="noopener"`
- [ ] 图标尺寸在 12/14/16/20/24 之内，`currentColor`，stroke 版
- [ ] 图标与中文混排有 translateY 补偿

**Agent 界面**
- [ ] 思考默认折叠、无打字机
- [ ] 工具三态可辨、失败显示原文
- [ ] 权限审批三个选项
- [ ] 停止按钮常驻
- [ ] 长输出已折叠

---

## 10. 常见错误（Anti-patterns）

| ❌ 错误 | ✅ 正确 |
|---|---|
| 用 `box-shadow` 抬升卡片 | 1px 发丝线，或反相深色 |
| 给正文加 `letter-spacing:.05em`「更透气」 | 正文字距 0，只有 ≥24px 标题加 `.01em` |
| 中文正文用 `line-height:1.5` | 1.75 |
| 用 12px 做页脚与元信息 | 13px |
| `#a3a3a3` 当说明文字 | 换 `--mute` #737373；`#a3a3a3` 只做装饰 |
| 深色卡固定给最贵档 | 绑定「当前可购主推档」 |
| 40px 按钮声称满足 AAA | AA 门槛是 24；要 AAA 就做 44px |
| 焦点环用 `rgba(59,130,246,.5)` | 实心 `#3b82f6`，半透明只有 1.84:1 |
| 代码高亮套彩色主题 | 单色系：字重 + 灰阶 + 斜体 |
| 行内代码用胶囊圆角 | 6px，与按钮形状必须可分 |
| 图标用 `align-items:center` 配中文 | `translateY(2~3px)` 对齐基线 |
| 表单只报「输入有误」 | 原因 + 下一步 |
| 工具失败翻译成人话 | 展示原始错误原文 |
| 思考过程做打字机效果 | 默认折叠，只显示耗时 |
| 权限审批只有一个「确定」 | 三个明确选项 |
| 长代码整块塞进消息流 | > 20 行折叠 |
| 骨架屏加扫光动画 | 仅透明度脉冲 |
| `prefers-reduced-motion` 直接关掉动画 | 换成不动的等价状态 |

---

## 附：最小可运行骨架

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<link rel="stylesheet" href="design.css">
</head>
<body>
<nav class="nav"><!-- sticky 56px，白色，1px 下边框 --></nav>
<main>
  <section style="margin-bottom:88px"><!-- 区块间距恒为 88px --></section>
</main>
</body>
</html>
```

完整可运行样例见 `ollama-ui-preview.html`。
