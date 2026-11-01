# Review：32题对比报告·结论预览版 PDF（report-preview-20261030-01）

- 评审对象：`C:\Users\mrzys\AppData\Roaming\fun.mrzys.tutor\maintenance\report-preview-20261030-01\output\pdf\math-comparison-summary.pdf`（3页，74,426字节，sha256 `575e7309…`）
- 数据源：原试验 `question-type-ab32-bailian-20261030-01/comparison-summary.json` ＋ 定向恢复 `catalog-blocked-seven-resume-20261030-01/recovery-summary.json`（含独立审稿 R01–R06、7 份处置记录、逐请求凭据）
- 评审日期：2026-10-30
- 评审方式：PDF 全文提取 ＋ 两份源 JSON 逐字段核对 ＋ 独立审稿原文比对 ＋ T12 补丁数学复算 ＋ 三页渲染检查 ＋ sha256 复算

## 总评

**数据层零误差。** PDF 中每一个可核对数字我都在原始记录里找到了出处且完全一致（含 7 次调用拆分、85,352 tokens、17→18 去重、累计快照 20/22 与 15/16、原试验 25 对配对统计 -83/-1秒/227,005/232,320、T12 补丁 1397>1000、反例 -1.992891）。上一轮 review 的四条意见全部落实：标题改为「改善集中于选择题」、补算危险放行率 21.1%/20.0% 并明确「不能据此认为安全性已经改善」、写明「正文更短，没有证明更省token」、「不能当作新一轮均衡A/B」。工程上有两个亮点：PDF 生成脚本前后置断言自校验（`create-summary-pdf.py` 行21、67–69）；sha256 双链（PDF 本体 + 源 recovery-summary.json）我复算均匹配。

遗留问题集中在**证据可追溯性**与**恢复轮安全指标未汇总**，见下。

## 逐项核对表

| PDF 声明（页） | 来源记录 | 结果 |
|---|---|---|
| 7份列表故障、2题跳过、实际恢复5份（页1） | recovery-summary：originalBlockedVariants=7 / skippedQualifiedQuestions=2 / actualResumedVariants=5 | ✅ |
| B-T17、B-T22 保留A臂合格稿、调用为0（页1） | skips[]：newModelCalls=0，notSubstitutedIntoB=true，existingQualifiedVariant=A-T22/A-T17 | ✅ |
| 7次请求均HTTP 200：DeepSeek生成3＋百炼Qwen复核4（页1） | calls：generation 3次/review 4次，httpErrors=0；请求文件实测 deepseek-flash 与 qwen3.7-flash | ✅ |
| Qwen为qwen3.7-flash、开启思考（页1） | protocol.json：reviewProvider=bailian, reviewModel=qwen3.7-flash, reviewThinking=on | ✅ |
| 列表、OCR和来源请求均为0（页1） | protocol.json：modelListRequests=0, sourceAndOCRCalls=0 | ✅ |
| 5行案例表（A-T18/A-T32/B-T12/B-T30/B-T14）（页1） | latest-dispositions.json 逐条：needs_review / review_failed×2 / ready_candidate / ready_candidate+classroomUsable | ✅ |
| B-T14 独立核对可用，a=1、b=-1，选A、C、D（页1） | R02：classroomUsable=true，切点/斜率联立 a+b=0、3a+b=2 → a=1、b=−1，f'(x)=(3x+1)(x−1)，A、C、D 正确 | ✅ |
| 单选6→8、多选2→4、填空4→2、解答1→1、合计13→15（页2） | comparison-summary byType（上轮已核，本轮复读一致） | ✅ |
| 核心问题候选4/19≈21.1% 与 4/20=20.0%（页2） | comparison-summary 独立审计汇总 | ✅ |
| 累计快照 A 19/19、13/13；B 20/22、15/16（页2） | combinedArms 完全一致 | ✅ |
| 按题去重可用终稿17增至18（页2） | distinctClassroomUsableQuestionsBefore/After = 17/18 | ✅ |
| 25对字符差中位数-83、HTTP耗时差约-1秒、token 227,005/232,320 增约2.3%（页2） | pairedInitialComparison：median=-83、-0.997、227,005/232,320（+2.34%） | ✅ |
| T18：a1=-5d 推出 a6=0 与"各项均不为零"矛盾（页3） | R03：2A+d=3(A+2d)→A=−5d→a₆=0，源题条件矛盾，非模型错误 | ✅ |
| T32：四位小数近似当精确σ=1取等；样本量/中心化影响（页3） | R01：P(1<x≤5)=erf(√2)=0.9544997…，q=0.0228 对应 σ≈1.00046；n=3 时 r_xz 只能取端点，需 n≥4 | ✅ |
| T12：距离差约-1.992891 而非-2；补丁1397字符超上限1000（页3） | root-counterexample.json：point(0.41421…,1)、actualDistanceDifference=-1.992891323641775、draftClaim=-2；proposal-stats.json：newCharacters=1397、replacementLimit=1000、teaching_patch_scope_exceeded | ✅ |
| T30：P=(1,2) 时切线 x=1、y=2，"另一交点"不存在（页3） | R05：y=2 代入 C:y²=4x 仅得 P=(1,2)，A/B 未定义，源域缺口 | ✅ |
| 生成47,304＋复核38,048＝85,352，思考token未重复相加（页3） | calls.generation.totalTokens=47,304、review=38,048；reasoning 54,667 ⊂ completion 60,975 | ✅ |
| 746题库、87条导入、624份复用材料不变，未入库（页3） | protection：formalBankUnchanged=true、materialFilesChecked=624、publicationCalls=0 | ✅ |
| sha256 双链 | pdf-validation.json 两个哈希复算均匹配 | ✅ |
| 三页渲染 | 逐页视检：中文（SimHei）正常、表格无溢出、页脚页码正常 | ✅ |

## 问题

### P1（中）T12 补丁的"独立核对"批评没有持久化记录

页3 T12 段原文：

> 独立核对还发现距离比较符号错误、配方漏减1、凭空排除合法点。

我对照 `audit-packets/R06-proposal.json` 的 `unappliedProposal` 补丁原文逐条数学复算，**三点全部属实**：

1. **符号错误**：补丁写「因为 $y\in[-2,2]$，所以 $|y-5|>|y+5|$」——对 y>0 不成立（y=1 时 4<6），因此 g'(t)<0 的单调递减论证仅对 y<0 成立，唯一性证明断裂；
2. **配方漏减1**：补丁写「$x^2 = 2-(|y|-1)^2-2|x|$」，由 $(|x|+1)^2+(|y|-1)^2=2$ 正确应为 $x^2 = 1-(|y|-1)^2-2|x|$；
3. **凭空排除合法点**：补丁写「（$y=2$ 舍去因对称性及题目隐含区域）」——(0,2) 满足曲线方程，"对称性"不构成排除理由（后文虽另行验证差值为−4，但该句排除依据不成立）。

问题不在结论而在**出处**：页3 写「依据：原comparison-summary.json、本次recovery-summary.json、独立审稿R01至R06…」，而这三条批评不在 R01–R06 任何一份里——R06 审的是 initial/final 正文（且「initial 与 final 相同」），`R06-proposal.json` 只保存了补丁原文（unappliedProposal），**没有保存对补丁的独立核对结论**。全文检索 maintenance 目录下所有 JSON/HTML 也找不到「漏减」字样。这份分析目前只存在于 PDF 断言中，等于结论版引用了一个不存在的审计编号。建议在恢复目录补一份 `R06-proposal-analysis.json`（含上述三点及复算依据），让 PDF 该句有可指认的落点。

### P2（重要）恢复轮的危险放行率没有汇总——这是本轮最强的安全信号

页2 只复述原试验口径：

> 原试验的程序候选为A 19份、B 20份。独立核对发现核心问题候选均为4份，比例约21.1%与20.0%。

但恢复轮本身新增了 2 份程序通过候选（B-T12、B-T30），**独立核对后 2/2 全部不达标**：T12 答案对但 B 项证明含硬数学错误，T30 存在源域缺口。即**本轮程序检查放行的候选，危险放行率为 2/2＝100%**；若计入累计口径，B 臂候选 20→22 而核心问题 4→（至少）5，约 5/22≈22.7%，较原 20.0% 上升。页2 明明重算了 20/22 与 15/16 两个累计数，唯独没有重算这个比率。PDF 用零散句子（「T12首次程序通过后被独立核对发现错误」）披露了事实，但没有聚合——而这恰是「不足以放宽自动入库标准」在本轮的最直接量化证据：恢复轮仅有的两份新程序通过候选，全部靠独立人工核对拦下。

### P3（建议）T14 的 A/B 同题对照未点明

页1 表格 B-T14 行只写：

> 独立核对可用；参数a=1、b=-1，选A、C、D

而同一题（第9题）A 臂（旧通用提示词）的初稿是**自检全过、ready 状态的错稿**（y=4(−1)+3=1，仅选C；正确为 a=1、b=−1，选A/C/D，见原试验 HTML 报告及 R02）。同题对照「通用提示词产出自检放行的错稿 vs 分题型提示词产出独立核对通过的正确稿」是本次提示词优化最直接的单点证据，比汇总表的 ±2 更有说服力。结论预览版定位是"直接阅读结果"，建议在页1 表格或"本次恢复"段补一句 A 臂背景。

### P4（轻微）"17增至18"紧邻"15 / 16"，口径易误读

页2 原文：

> 按题去重，可用终稿从17增至18，共32题。

数字正确（按题去重：13∪15=17 → 13∪16=18），但该句紧贴 B 行"15 / 16"的表格，两套口径并排且无公式——我做的渲染检查中，视检模型直接将其判为"数据矛盾建议核对"。建议补括号说明：「（两臂按题去重：13∪15=17 → 13∪16=18，新增的1题即第9题B稿）」。

### P5（轻微）页1 类别重叠未提示

页1 原文：

> 最新形成2份程序候选，其中1份独立核对可用，4份继续待处理。

B-T30 同时属于"2份程序候选"和"4份继续待处理"（程序通过但题意范围待核对），2 与 4 不加不等于 5，需读到页2 的「T30程序通过但题意范围仍需核对」才能解析。可在"4份继续待处理"后加"（含已程序通过的T30）"。

### P6（延续）AGENTS.md 决策分叉第三轮未闭环

PDF 如实写「阿里云百炼Qwen复核」「qwen3.7-flash」（页1），但 AGENTS.md 第25行已采纳决策仍是「千问AI平台Qwen3.8 Flash」。与 10-29、10-30 上午两轮相同的问题：实现已切百炼，决策记录未更新。连续第三轮提示，建议尽快补一条带日期的决策记录闭环。

## 值得保留的做法

- 生成脚本前置断言（行21 `assert recovery['independentlyUsableNew']==1 and recovery['stillPendingNew']==4`）＋ 后置断言（行67–69 页数与关键词），防止报告与源数据脱钩；
- `pdf-validation.json` 记录 PDF 与源 JSON 双 sha256，可复算（本轮已复算匹配）；
- 跳过 B-T17/B-T22 时 `notSubstitutedIntoB=true` 并在页1 明写「没有把A稿填成B的试验结果」，保住了原 A/B 冻结比较的纯洁性；
- 用量口径诚实：reasoning tokens 明确声明含于输出未重复相加（实测 totalTokens=prompt+completion 成立）；
- `scope: "Conclusion preview only"` 与页1「结论版用于直接阅读结果」声明一致，未冒充完整报告。

## 结论

发布层面可用：所有数字与出处一致、渲染合格、边界声明诚实。建议下一版做三件事：① 为 T12 补丁批评补持久化审计记录（P1，修复"依据"段的引用缺口）；② 把恢复轮 2/2 危险放行与累计约 5/22 写进页2（P2，这是比原试验 21.1%/20.0% 更强的自动入库反证）；③ T14 补 A 臂错稿对照一句（P3）。P6 的 AGENTS.md 决策闭环仍待处理。
