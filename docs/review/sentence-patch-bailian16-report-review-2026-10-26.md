# 句段补丁-百炼Qwen-16份候选对比报告的 review（2026-10-26）

评审对象：《句段补丁-百炼Qwen-16份候选对比报告》总结稿（试验目录 `C:\Users\mrzys\AppData\Roaming\fun.mrzys.tutor\maintenance\sentence-patch-bailian16-20261026-01\`）。
评审方式：全部结论逐条对照该目录下的 `run-summary.json`、`comparison-summary.json`、`protocol.json`、`patch-prompt.txt`、`post-audit-dispositions.json`、`independent-audit/R13.json` 等原始记录核实。

## 一、核心数据核实：主表全部属实

| 总结稿声称 | 原始记录 | 结论 |
| :--- | :--- | :--- |
| 旧 ready 3/16（18.8%）→ 新 9/16（56.3%） | `run-summary.json` 第 7 行 `"ready": 9`；`comparison-summary.json` 第 5–6 行 `"oldProgramReady": 3, "newProgramReady": 9` | ✅ 属实 |
| 独立可用终稿 0/16 → 6/16 | `comparison-summary.json` 第 7–8 行 `"oldIndependentlyUsable": 0, "newIndependentlyUsable": 6` | ✅ 属实（但计数口径见 2.1） |
| 复核中位 49.2s → 39.0s（-21%）、最大 97.2s → 79.6s | `comparison-summary.json` 第 28–31 行 | ✅ 属实（-20.8%） |
| DeepSeek 调用为 0、复用上轮 16 份初稿、11 道题 | `run-summary.json` 第 4 行 `"generationApiCalls": 0`；`protocol.json` 第 4–5 行 | ✅ 属实 |
| 救回名单 B-q03、A-q06、B-q06、B-q07、B-q10、B-q22 | `comparison-summary.json` 第 20–27 行 `restored` | ✅ 属实 |
| 9 道程序通过中仍有 3 道须修正（B-q04、A-q20、A-q22） | `comparison-summary.json` 第 14–18 行 `newReadyWithKnownProblems` | ✅ 属实 |
| 未授权文本 0 污染 | `protocol.json` 第 45 行 `oldReviewAllowanceAndResultsUnchanged: true`；`report-validation.json` 第 7 行 `all50PriorArmResultsUnchanged: true`；protectedNonTargets 34 | ✅ 属实 |
| 8192 思考预算 | `protocol.json` 第 16 行 `"thinkingBudget": 8192` | ✅ 属实 |

合规性同样全部有据：显式授权（`protocol.json` 第 44 行 `explicitExtraReviewAuthorized: true`）、每目标仅一次复核（第 8 行 `maxReviewCallsPerTarget: 1`，实际 `reviewApiCalls: 16`）、不写库不写设置、代码哈希冻结、旧额度与旧结果不变。这轮隔离试验本身无可挑剔。

## 二、必须修正的表述（按严重度排序）

### 2.1 「救回了 6 道真正课堂可用的优质解析」——按题计数应为 5 道

> 被质疑原文：「新版成功救回了 **6 道真正课堂可用的优质解析**！」

`comparison-summary.json` 第 192–199 行明确区分了两个口径：

```
"newUsableDistinctQuestions": 5,
"alreadyUsableOtherVariant": ["B-q07", "B-q09", "B-q12", "B-q18", "A-q20"]
```

6 是**候选（份）**数；**按题去重后净新增可用题只有 5 道**——B-q07 所在题在前几轮已存在独立通过的另一变体（本轮按 `protocol.json` 第 6 行 "Previously independently qualified finals excluded" 排除在外），B-q07 只是同题第二个可用变体。总结稿用「道」字（题目量词）表述 6，会高估净收益一题。应改为「6 份候选、对应 5 道净新增可用题」。

### 2.2 「输出 token 锐减」漏了 prompt 上升

> 被质疑原文：「Qwen 仅需生成目标句段，**输出 token 锐减**，推理速度提升超五分之一。」

`comparison-summary.json` 第 32–41 行：completion 98,421 → 72,989（-25.9%）、reasoning 78,339 → 65,083（-16.9%），这两项确实锐减；但 **prompt 由 60,655 升至 70,095（+15.6%）**——句段合同（segmentId/expectedText/哈希）本身增加了输入体积。合计 token 仅降 12.3%。结论方向不变（completion/reasoning 单价更高，总成本仍降），但「输出 token 锐减」不提输入变重，收益被夸大了一档。另：耗时 -21% 主要来自 completion 缩短，与「思考算力聚焦」的归因一致，这条保留。

### 2.3 局限一的 B-q04 案例：只有一半是补丁新伤

> 被质疑原文：「**典型案例（B-q04）**：补丁为了使解答紧凑，删掉了初稿关于 $t \to \pm\infty$ 的端部趋势描述，导致三次方程根的存在性依据缺失。」

B-q04 有两条 must_fix（`comparison-summary.json` 第 66–78 行）：
- 「恰有3个交点」端部行为缺失——确为补丁删减新伤，归因正确；
- 「对应3条不同切线」不同切点可能同线的区分论证缺失——`comparison-summary.json` 第 77 行原文：**「此缺口初稿已存在」**。

即第二条是从初稿继承的旧伤，句段补丁即便完美也无法让 B-q04 达标。把它整体归入「防卫性截断」的隧道视野，会误导后续以为修好截断问题 B-q04 就能救回。同理 A-q22 的两条问题也「在初稿即存在，本次仅改元数据措辞并未修复」（第 153 行原文）——总结稿在 A-q22 上归因正确，在 B-q04 上归因不准。

### 2.4 报告漏了第四类失败模式：invalid_teaching_patch（A-q03、A-q04），且 A-q04 状态降级值得写明

「三类未解困境」不完整。`run-summary.json` 第 9 行 `review_failed: 5` 中：
- B-q09、B-q18、B-q23 是 `teaching_patch_unresolved`（总结稿已覆盖前两个）；
- **A-q03、A-q04 是 `invalid_teaching_patch`**——本地合同校验直接拒绝采纳补丁，属于另一类失败：Qwen 提议越界/不匹配，程序物理拒绝。这正是「失败保留原则」起作用的证据，报告总结却只字未提。

尤其 A-q04（`comparison-summary.json` 第 216–227 行）：旧流程 `ready_candidate`（但独立核对不可用，硬伤被放行）→ 新流程 `review_failed`。**状态降级不是退步，而是把旧版「带病放行」换成「诚实拒绝」**，这是新机制相对旧机制的重要优点，总结稿应当写反而没写。

### 2.5 报告漏了系统性「接缝重复」缺陷：两份终稿出现同型拼接 bug

独立核对发现两处同构的 minor 问题，总结稿均未提及：
- B-q03（`comparison-summary.json` 第 235 行）：「令 $f'(x)=0$，得\n令 $f'(x)=0$，得」——「补丁末尾与保留的下一句完全重复」；
- A-q20（`independent-audit/R13.json` 第 21–22 行）：「所以 $h(t)$ 在 $t=2$ 处取得最小值又 $h'(2)=0$，所以 $h(t)$ 在 $t=2$ 处取得最小值」——「替换段已带入其后旧段仍保留的结论，产生重复拼接」。

这是句段替换机制的**固有接缝风险**：newText 结尾与紧邻保留下句语义/字面重复。两个独立候选命中同型 bug 说明不是偶发。对应修复成本极低：合并后在本地做一条校验——newText 末句与下一保留段首句做归一化字符串比较（去空格/公式空白），命中即去重或判 invalid_teaching_patch 打回。建议随句段补丁一并合入。

## 三、落地建议的修正（三条建议方向对，细节要改）

### 3.1 建议 2「由 DeepSeek 全文重新换通法生成」与既定流程边界冲突，必须加约束

> 被质疑原文：「**重度问题**……或由 DeepSeek 全文重新换通法生成，避免 Qwen 做无效修补。」

AGENTS.md 既定边界：「失败或残留保留待复核，**不循环、不回退DeepSeek复核**；已核对通过的候选按题保留，不被后续问题稿覆盖」「旧已用额度不重置；**明确授权的新隔离试验单独记账**」。把 DeepSeek 重生成写成流程内自动 fallback 会违反这两条。正确表述应为：
- 重算属于**新一轮显式授权的生成任务**：单独记账、不覆盖旧稿与旧成功记录、不占旧额度；
- 且存在鸡生蛋问题：**「核心方法超纲」是在 Qwen 复核之后才知道的**，本轮一次复核额度已消耗。可行的零成本替代是：句段合同已允许 Qwen「发现需要换整套方法……保留原稿，在 unresolvedIssues 具体说明」（`patch-prompt.txt` 第 5 行原文），程序把这类「建议换方法」的 unresolved 直接落 `needs_review`，不试图打补丁——这不需要额外调用，只需在 disposition 分类里识别「方法级不可修」信号。

### 3.2 建议 3「本地规则拦截」既必要又不充分，且规则本身要加防呆条件

总结稿说「程序本地必须承担起元数据过滤的职责」，方向正确，但漏了一个关键事实：**本轮补丁提示词已经告知了 Qwen 这一点**。`patch-prompt.txt` 第 8 行原文：

> 「originalMaterial.questionType=multiple_choice时，多项成立是合法情况，不以此认定原题矛盾」

Qwen 仍然死锁了（B-q09：承认误报却因 `allowedSegments 为空` 只能标 unresolved）。且 `patch-prompt.txt` 第 7 行本就写明「**只有核实为误报或确已解决的意见才可resolved**」——合同语义上允许「误报→resolved（零补丁）」，是 Qwen 未正确执行。因此修复必须是双管齐下：
1. 本地预过滤（总结稿方案）：把该类疑点在送审前丢弃；
2. **程序侧 disposition 分类**（总结稿缺失）：对允许误报存在的合同，把「模型核实为误报」与「真问题未解决」区分落盘——B-q09 的独立核对意见原文（`comparison-summary.json` 第 90 行）：「应明确区分『数学及题型事实已澄清、原疑点属误报』与『合同或记录操作未完成』，不能把后者写成原题待修」。只做 1 不做 2，任何未被过滤规则覆盖的误报还会重演同样的死锁。

另外过滤规则要加防呆条件：**不能只信 metadata 枚举**。建议条件为「questionType=multiple_choice **且** 答案实际含 ≥2 个正确选项」才丢弃「未注明单选多选」疑点；若枚举与答案不符（比如标了多选但答案只有一项正确），那是真材料冲突，恰恰应该送审。

### 3.3 建议 1「已经成熟、合并正式管线」：样本与决策程序都要补

- 样本量：n=16 份候选、11 道题、单一试卷批次、单一模型（bailian `qwen3.7-flash`，见 `review-profile.json`，并非默认复核位上的千问平台 Qwen3.8 Flash）。数据说服力足够支持「机制方向正确」，但「成熟到直接合并」建议再跑一批不同来源的候选验证后定案；
- 决策程序：按 AGENTS.md「不能在代码中静默改变已确认的流程边界」，合并应走显式采纳（ADR 或用户确认），且须保留旧字段合同用于旧记录重放（`patch-prompt.txt` 第 4 行已为此设计，合并时不能丢）。

## 四、结论

总结稿的工程判断——**采纳句段补丁替代旧版全字段 Patch**——有完整数据支撑，同意。但定稿前须修正：计数口径（6 份候选 = 5 道净增题）、token 收益表述（补 prompt +15.6%）、B-q04 归因（一半为初稿继承伤）、补写 invalid_teaching_patch 这第四类失败模式与接缝重复缺陷，并把三条落地建议中与「不循环/不回退/单独记账」边界冲突的 DeepSeek 重生成分支改为显式授权任务、把本地元数据过滤补成「过滤 + disposition 分类」双修复。
