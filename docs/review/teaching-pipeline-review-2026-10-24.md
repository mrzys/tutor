# 题目教学稿处理流程评审

2026-10-24。评审对象是教学稿生成与复核流程本身，不是 28 道题的数学内容。本轮只评审，不改动代码、提示词或词表，不发布候选。

评审依据为仓库内已有文件与试跑记录，不引入外部最佳实践，也不把下列任何一条说成实测正确率。

## 评审前的账目

先固定分母，否则"可用率"无法讨论：

| 口径 | 数值 | 出处 |
|---|---:|---|
| 正式题库 378 题 | 363 ready + 15 待复核 | `docs/design/math-teaching-analysis-prompt.md:5` |
| 155 试跑 · 规则无标记 | 137/155 = 88.4% | `docs/review/qwen-six-timeout-diagnosis-2026-10-24.md:25` |
| 155 试跑 · 扣除已发现问题 | 127/155 = 81.9% | 同上 `:26` |
| 定向复核后 · 无已知问题候选 | **135/155 = 87.1%** | `docs/review/qwen-scoped-review-2026-10-24.md:39` |

最后一个是最新可用口径，去重待处理 20 道。用户提出的 90% 目标对应 140/155，即需再解决 5 道。

20 道待处理的构成（由 28 道清单扣除已合格的 8 道得出）：

| 分类 | 数量 | 具体题目 |
|---|---:|---|
| 答案有实质错误 | 1 | 湖南19（大连13 已合格） |
| 推导需修正 | 4 | 北京16、大连8、大连19、湖南8 |
| 高中表达需调整 | 5 | 天津9、天津16、天津20、重庆8、重庆19 |
| 需核对原题 | 4 | 天津2、重庆16、天津4、巴中14 |
| 告警过严 | 4 | 北京4、北京17、北京18、湖南12 |
| 显示格式 | 1 | 湖南18 |
| 尚无完整稿 | 1 | 北京21 |

---

## 发现 1：范围控制停在提示词层，没有落到程序约束

三处原文并列，它们描述的是同一个机制：

`docs/review/qwen-scoped-review-2026-10-24.md:7`：

> 共享 `scripts/resources/teaching-quality-review-instruction.txt` 按实际问题限定修改范围：表达／显示优先局部修改；方法问题重写必要的高中推导……**返回完整对象不等于重写全部内容**。

`scripts/resources/teaching-quality-review-instruction.txt:9`：

> 请返回完整结果，修复 JSON 只是入口，不是复核的全部。

`docs/review/qwen-scoped-review-2026-10-24.md:31`：

> 湖南5仅修改学生要求第2条，其余字段原样保留，**约14.29秒完成**；天津16原本仅难度依据一处"约束"，新稿却改写多处内容，新增字面换行转义和11个公式显示错误。范围指令有帮助，**但不是程序性修改限制**。

第三段是关键：同一模型、同一份指令、同一输出预算下，模型真的只改一处时耗时 14.29 秒，改写全文时是 90~281 秒且 43% 超时（`qwen-six-timeout-diagnosis-2026-10-24.md:15`、`:28`）。

这三条放在一起说明：文档层已经认定"返回完整对象不等于重写全部内容"，指令层也已经写了"表达／显示优先局部修改"，但**没有任何程序环节把这条落实成契约**——输出合同仍要求全部字段，模型是否遵守只能靠自觉，不遵守时无降级手段。

天津16 是最典型的失败样本：原始问题只是难度依据里一个"约束"，本次复核把整篇重写，结果新增 11 个公式显示错误，比原稿更差。

## 发现 2：复核会引入新问题，契约已知但不设防

`scripts/lib/teaching-term-pipeline.mjs:24` 的注释：

> At most one REVIEW call, **including when that review introduces new terms**.

这条注释表明设计者已经知道复核会引入新术语，当时的处置是"不再复核"。问题在于契约只规定了**事后不再复核**，没有任何环节**事前阻止引入**。

实证来自 `docs/review/qwen-scoped-review-2026-10-24.md:32`：

> 原问题修好但新增问题 2道：天津16新增显示问题；**湖南8新增"上界"**。

以及 `:33`：

> 湖南8补出了圆周四段角中至少一段不超过直角的论证，真正证明任意摆放都不能更大，但新用了三处"上界"，所以证明修好仍未算整稿合格。

这两处并列可以看出流程的一个结构性弱点：**复核的收益与损耗记在同一笔账上**。湖南8 的数学证明已经修好——这正是用户清单里"最优摆放方式缺证明"的修复目标——但因为引入三处"上界"命中词表，整稿仍不合格。原问题解决了，可用率没有增加。

## 发现 3：文档承诺的术语轻量通道，正式路径并未接入

`docs/design/math-teaching-analysis-prompt.md:64`：

> 2026-10-23已另行实现术语触发维护管线：只有术语命中才发送复核请求，附上原句与检查建议；附加指令与下方通用复核指令组合使用，主提示词不变。

实际引用情况：

| 文件 | 引用的复核指令 |
|---|---|
| `desktop/src-tauri/src/model.rs:1398` | 仅 `teaching-quality-review-instruction.txt` |
| `desktop/src-tauri/src/imports/teaching.rs:11` | 仅 `teaching-quality-review-instruction.txt` |
| `scripts/lib/teaching-term-maintenance.mjs:50` | `teaching-term-review-instruction.txt` |
| `scripts/run-scoped-teaching-review.mjs:66` | 仅 `teaching-quality-review-instruction.txt` |

轻量术语指令 `teaching-term-review-instruction.txt` 在整个仓库里只有 `teaching-term-maintenance.mjs:50` 一处使用；正式应用的两处入口和离线定向入口都只接了综合指令。

后果是：一个仅仅因为难度依据里出现"下界"而命中的题目，与一个存在实质数学错误的题目，走的是同一条最重的通道。这直接解释了表达类 5 道题（天津9、16、20、重庆8、19）为何长期滞留——它们本不需要完整复核，却在和数学错误题争抢同一份 300 秒预算。

## 发现 4：三条管线对"模型自报 issues"的处置互不一致

`scripts/lib/teaching-quality-pipeline.mjs:38`：

> `for (const issue of parsed.issues) out.findings.push({ type: 'model_issue', issue });`

`scripts/lib/teaching-format-recovery.mjs:108`：

> `if (parsed.issues.length) output.needsReviewReasons.push({ code: 'model_reported_issues', issues: structuredClone(parsed.issues) });`

`scripts/lib/teaching-term-pipeline.mjs` 全文不检查 `issues`。

前两处把模型自报直接升级为阻断性 finding，第三处完全不看。这就是告警过严 4 道题（北京4、17、18、湖南12）滞留的机制来源：模型把自己对干扰项、参考笔误、读图限制的疑虑写进 `issues`，程序据此判定稿件不可用。

对照 `docs/review/qwen-scoped-review-2026-10-24.md:15`：

> 北京4、17、18和湖南12的教学内容已有可用证据，只剩来源或过严告警，因此保留原稿和标记、不重新调用模型。

这四道的处置结论本已明确，但程序侧没有对应的"已知误报"通道，它们仍以 pending 状态占用分母。

## 发现 5：同一异常在两处管线的处理不一致

`scripts/lib/teaching-quality-pipeline.mjs:19-24`：

> `try { checked = validateTeachingResult(parsed, questionId); } catch (error) {`
> `  if (error?.code !== 'incomplete_result_without_explanation') throw error;`
> `  checked = { textComplete: false }; }`

`scripts/lib/teaching-format-recovery.mjs:95`：

> `const checked = validateTeachingResult(parsed, original.questionId);`

`validateTeachingResult`（`teaching-term-pipeline.mjs:17`）在"不完整且无说明"时抛 `incomplete_result_without_explanation`，但在"不完整**且**有 issues 说明"时返回 `{ textComplete: false }`。

quality 管线捕获该异常并降级继续，format 管线不捕获，直接跳到 `:113` 的 catch 返回 `recovery_failed`。结果是同一份稿件经过两条维护路径会得到相反的结果，且 `format-recovery.mjs:107` 的 `if (!checked.textComplete)` 分支在抛异常路径下不可达。

## 发现 6：生成提示词第 4 条是"讲解要求"，不是"枚举要求"

`docs/design/math-teaching-analysis-prompt.md:25`：

> 4. 讲清影响结论的定义域、正负、分类、端点、舍解及图形位置。求最值须证明该数能取到；**求出参数或构造反例后检查全部原条件**。

这条已经要求"检查全部原条件"，大连13、大连9、天津14 却仍然出错。三题的共性不是没讲清舍解，而是**几何退化与边界位置未经枚举**：

- 大连13：切线与横轴重合的点被算进"平行"，产生增解
- 大连9：遗漏点重合的退化情形
- 天津14：最远点所在方向说反

提示词要求的是"把已经识别出的情形讲清楚"，缺少"先枚举再逐值代回验证"的操作步骤。模型在解析里写了舍解说明，却没有识别出需要枚举的那些情形——要求讲清，不等于要求枚举。

这三道目前均已在新稿中合格，但提示词层面的缺口仍在，会影响后续新题。

## 发现 7：规则与内容冲突时，一律以规则阻断

见发现 2 引用的 `qwen-scoped-review-2026-10-24.md:33`：湖南8 的证明已经正确，仍因三处"上界"判不合格。

同类还有 `:33` 中的天津4：

> 天津4正确保留百分号解释分歧，却另添显示问题。

当前流程里，词表命中、显示告警、模型自报、数学错误四类 finding 共用同一个阻断出口，没有优先级与类型区分。结果是**表达类问题与数学类问题被同等对待**，而前者往往只需局部改写。

---

## 对 90% 目标的账目推算

按"是否需要重新解题"重排 20 道待处理：

| 类别 | 数量 | 题目 | 是否需要重新解题 |
|---|---:|---|---|
| 告警过严 | 4 | 北京4、17、18、湖南12 | 否，摘出阻断链即可 |
| 显示格式 | 1 | 湖南18 | 否，本地清除残留 |
| 表达（内容已修好） | 2 | 湖南8、天津16 | 否，仅剩表达残留 |
| 表达 | 3 | 天津9、天津20、重庆8、重庆19 中可复用现有稿的部分 | 部分 |
| 推导 | 4 | 北京16、大连8、大连19 及湖南8 剩余部分 | 是 |
| 答案错误 | 1 | 湖南19 | 是 |
| 核对原题 | 4 | 天津2、重庆16、天津4、巴中14 | 流程无法解决 |
| 无稿 | 1 | 北京21 | 需新生成 |

前三类合计 7 道不需要重新解题，若单独闭环即可由 135 增至 142/155 = 91.6%，跨过 90%。这个推算依赖"不重新解题"的分类成立，尚未经实测，不应写成已达成。

## 明确不建议改动的部分

- 不因表达类问题而放宽数学阻断。发现 7 的结论是分类分流，不是降低标准；湖南19 的参数错误、北京21 的缺稿仍须保留阻断。
- 不把 135/155 当作实测正确率。该口径含此前未完成全量独立核验的题目，出处文档 `:39` 已明确这一限制。
- 不取消"每题一次复核"的额度约束。发现 1 与发现 3 指向的是降低单次成本，不是增加次数。
- 不为消除词表命中而删改题意或牺牲正确性，这是 `teaching-term-review-instruction.txt:2` 已有的约束。
