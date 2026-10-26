# 10 张真实试卷：受限补丁工作流核验

日期：2026-10-25。范围是普通原件上传、来源整理、独立教学稿生成及命中后的一次 Qwen 复核，使用隔离数据目录。首轮与本次试跑中的单次显式定向恢复分别留档；没有修应用、重跑受保护候选或入库。这是模拟／回归案例，不是真实教师采用或教学有效性证据。

本机证据目录：[ten-paper-bounded-patch-20261025-01](C:/Users/mrzys/AppData/Roaming/fun.mrzys.tutor/maintenance/ten-paper-bounded-patch-20261025-01/)。完整[HTML 报告](C:/Users/mrzys/AppData/Roaming/fun.mrzys.tutor/maintenance/ten-paper-bounded-patch-20261025-01/10张新试卷-受限补丁工作流实际效果报告.html)使用最终 continuation 分析及协调器；不沿用旧协调器的结束状态。

## 结果与分母

| 指标 | 冻结首轮 | 显式恢复后的最终状态 |
| --- | ---: | ---: |
| 原卷题量 | 190 | 190 |
| 来源完整性通过、已结构化 | 4 卷／76 题 | 6 卷／114 题 |
| 系统自动候选 `ready_candidate` | 55 | 88 |
| `needs_review` | 14 | 18 |
| `generation_failed` | 7 | 8 |
| Qwen 实际请求 | 11 | 28 |
| 受限补丁请求／实际接受 | 5／1 | 8／3 |
| 完整复核请求 | 6 | 20 |
| 复核超时 | 3 | 6 |

最终另有 4 卷、76 题处于来源阻断。114 道结构化题中有 26 道待复核或生成失败，来源阻断按卷另列，不把这些单位解释为每题都需教师重解。88/190 是系统状态比例，不是数学正确率或可入库率；来源保真、素材、版本、重复题及教师确认边界仍有效。

固定样本在请求前选定每卷原题 2、8、16，共 30 题；目前 18 题有与当前候选哈希匹配的独立判定，另 12 题因来源阻断无教学候选，保持 unknown。额外定向 Qwen 案例单列，不混入固定分母。

| 固定样本判定 | 结果 |
| --- | ---: |
| 完整数学解有效 | 16/18 |
| 课堂内容可用 | 15/18 |
| 当前应用显示兼容检查 | 16/18 |
| 数学、课堂（内容与显示叠加）、来源同时通过 | 13/18 |
| 固定样本中进入 ready 的漏检候选，按数学／来源去重 | 1 |
| 固定样本中进入 ready 但课堂需调整 | 4 |
| 独立三项通过但仍留置复核 | 1 |

完整数学解采用显式 `mathematicalSolutionValid`，或 `mathCorrect && proofComplete`。显式答案判定字段仅覆盖 7 题且均为 true，不能据此写成 18 题答案全部正确。固定样本非随机抽样，上述数字不外推到 190 题。参考也非权威真值：福建第 2 题原卷独立推导为 B，配套答案表为 C；贵州第 2 题盲稿选项转录更正另存，原冻结文件未覆写。

统计与哈希见[最终分析](C:/Users/mrzys/AppData/Roaming/fun.mrzys.tutor/maintenance/ten-paper-bounded-patch-20261025-01/effective-analysis-continuation.json)、[固定真值](C:/Users/mrzys/AppData/Roaming/fun.mrzys.tutor/maintenance/ten-paper-bounded-patch-20261025-01/fixed-sample-truth.json)及[报告核验](C:/Users/mrzys/AppData/Roaming/fun.mrzys.tutor/maintenance/ten-paper-bounded-patch-20261025-01/report-verification.json)。

## 技术阻断与保真问题

- 安徽第 4 卷：来源整理末批请求超时（配置预算 120 秒），保留技术超时，不计教学数学错误。
- 山东第 5 卷：同一原 PDF 可由 MuPDF 渲染，但应用使用的 lopdf 拒绝其 trailer；失败发生在 OCR 提交前。已观察尾部 xref 异常及跨解析器差异，不宣称所有阅读器都无法读，也不归咎 OCR 服务商。见[只读解析复现](C:/Users/mrzys/AppData/Roaming/fun.mrzys.tutor/maintenance/ten-paper-bounded-patch-20261025-01/independent-source-technical-audit.json)。
- 贵州第 9 卷：第 15 题原卷、OCR 题号、正文及两问均在。Markdown 将题号接在章节标题行末，行首正则未命中；布局块含换行题号，但 54 字符、UTF-8 144 字节未满足 Rust `body.len()<100` 补救门槛。实际整卷 `question_import` HTTP 200/stop 返回完整 1—19 及第 15 题关联，程序 expected 仅 18，误报多出 15。两物理页走整卷短文整理，不是 source-batch 索引模型漏题、OCR 丢正文或模型捏题。见[精确覆盖复现](C:/Users/mrzys/AppData/Roaming/fun.mrzys.tutor/maintenance/ten-paper-bounded-patch-20261025-01/paper09-question15-coverage-diagnosis.json)。
- 江苏第 10 卷：四个额外选项裁图没有原文块绑定，未发给任何来源批次，最终全量资产校验却要求其角色；已有两列实际选项图已正确绑定。属于投递域与最终校验域不一致，不是原图缺失或模型漏答未收到的资产。见[素材归属诊断](C:/Users/mrzys/AppData/Roaming/fun.mrzys.tutor/maintenance/ten-paper-bounded-patch-20261025-01/paper10-material-role-diagnosis.json)。
- 福建第 2 卷恢复保护曾因正常新增 `physicalPages` 元数据误报 `source_changed`；历史 failed 原样保留，补充只读复核确认原字节与旧审计均不变。见[补充保护核查](C:/Users/mrzys/AppData/Roaming/fun.mrzys.tutor/maintenance/ten-paper-bounded-patch-20261025-01/independent-paper02-protection-recheck.json)。
- 河南第 11 题原 PDF 为 `A₁E=3EB₁`，录入却为 `A₁B=3EB₁`；生成稿按真实 E 条件解对，不能抵消保存题面的错误。`sourceFieldsUnchanged` 仅证明字段保护，不证明原卷保真。见[河南第二波审计](C:/Users/mrzys/AppData/Roaming/fun.mrzys.tutor/maintenance/ten-paper-bounded-patch-20261025-01/independent-candidate-audit-paper06-recovery-wave02.json)。

## 漏检、误报与补丁效果

固定样本湖北第 8 题答案正确，但用无误差界的小数近似代替关键比较证明。额外定向案例湖北第 14 题仅补修 `examFocus` 后仍为 `ready_candidate`，原解仍缺全局取等可行性的说明；固定样本“漏检 1 题”不代表所有已知漏检只有 1 题。湖北第 17 题首稿擅据示意图只留一个线面角，漏掉合法分支；该题 Qwen 超时未返回、旧稿哈希未变，不能记作 Qwen 数学通过或新产生的数学错误。

湖北第 10 题实际请求已明确 `multiple_choice`，ACD 均可实现，复核仍保留“可能应为多选”的假疑点。不同审计的误报字段不统一，报告逐题保留证据，不把仅两个布尔字段覆盖的子集冒称全量误报数。河南第 16 题引用的双曲线切线定理及数学链正确，但需要补出普通高中可讲解的推导；课堂不足不自动计数学错误。

8 次受限补丁中，3 次实际接受、1 次明确 unresolved、4 次缺少有效响应；这是合同采纳结果，不是独立数学通过率，也不证明提速。原值、获准字段、来源与候选哈希、实际响应及失败均保留。28 次复核中的 6 次超时与模型目录技术失败分开，不因没有输出而判数学错误。

河南 4、5、6、18、19 共 5 题有 8 个额外空字段：7 个空字符串及 1 个 null，来自 3 份生成响应文件。provider 正文都是可解析 JSON，失败的是严格字段合同。4、5、6、18 是 schema-only 触发，首稿数学已正确；19 另有 8 条 Φ 语境命中，不能归为仅 schema 触发。见[逐 JSONPath 原值索引](C:/Users/mrzys/AppData/Roaming/fun.mrzys.tutor/maintenance/ten-paper-bounded-patch-20261025-01/paper06-extra-fields-provider-evidence.json)。

本轮冻结现有正常导入配置，未人为挑方法卡增强。方法参考仅按实际请求 `referenceAttached` 类字段统计；缺少显式字段记 unknown，不据旧文档宣称附加或测试了八板块参考。

## 显示验证与交付边界

当前应用静态探针扫描 106 个候选，发现 14 个定界符兼容风险；未逐题做 UI 截图。实际 ImportPaper 隔离副本只验证湖北第 2 题，1440／390 下生成稿 KaTeX 均为 0、仍显示 7 对反斜杠括号公式，证实该案例的应用显示问题。报告自己的 KaTeX 成功不能把应用判为通过。

最终 HTML 已用现有 Playwright／Edge 在 1440×1000、390×844 检查身份、非空、导航、展开、公式、实际应用证据图片、无整页横向溢出、无控制台错误及无外部请求；Browser 插件不可用，未安装新依赖。见[最终浏览器 QA](C:/Users/mrzys/AppData/Roaming/fun.mrzys.tutor/maintenance/ten-paper-bounded-patch-20261025-01/report-browser-qa.json)。

真实题库仍为 **392 题**，逻辑哈希不变，试验入库动作 0；模型/OCR 配置、冻结资源、二进制及全部原 PDF 的只读安全核对通过。见[最终安全复核](C:/Users/mrzys/AppData/Roaming/fun.mrzys.tutor/maintenance/ten-paper-bounded-patch-20261025-01/final-safety-verification.json)与[试验进程结束检查](C:/Users/mrzys/AppData/Roaming/fun.mrzys.tutor/maintenance/ten-paper-bounded-patch-20261025-01/report-process-exit-check.json)。本次仓库写入仅此新文档，未提交。

最终 HTML SHA256：`0cb54d4bfef10553d85e361ceefc9f994c668a83278722faf2e3a5010c7622d2`。报告、verification 与浏览器 QA 的报告哈希一致。
