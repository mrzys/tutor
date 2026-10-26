# 四卷来源恢复实测（2026-10-25）

本轮是使用真实原卷、真实接口和隔离数据的回归案例，不代表真实教师使用或教学效果。只继续第4、5、9、10卷，复用已有OCR和成功结果；没有发布题目，没有重置Qwen额度，没有复制或打开真实个人库。

## 实际结果

| 项目 | 修复前冻结终态 | 本轮终态 |
| --- | ---: | ---: |
| 来源已结构化 | 114/190 | 171/190 |
| 系统自动候选 `ready_candidate` | 88 | 133 |
| 需复核 `needs_review` | 18 | 24 |
| 生成失败 `generation_failed` | 8 | 14 |
| 整卷来源阻断 | 4卷76题 | 济南1卷19题 |

恢复了3/4个目标卷的来源处理，新增57道已结构化题、45个系统自动候选。原88个及阶段1新增29个候选、其余8卷完整记录、原件/OCR/成功来源批次均受保护。**系统自动候选不是数学合格题、直接学生交付题或可入库率。真实题库仍为392题，发布动作0。**

## 四卷处理与残留问题

- 安徽：复用原OCR及9个成功批次，只继续末批，19题恢复。旧21.135秒早退不能冒充耗尽120秒思考预算；本轮另有实际`isConnect=true/isTimeout=true`、OS10060连接失败，按真实transport分类。
- 济南：本地PDF检查仅在内存兼容异常xref，原字节原样交OCR，4页OCR已保存。阶段2文本索引出现两个8；阶段3明确附原页图重新索引，模型判断第三个向量题为3，但人工仍看见原号重影。首批转录又返回8，与索引3冲突，程序正确阻断。保留完整19题材料，不按排序改号、不删题、不继续模型重试，需要清晰来源核对。
- 贵州：原第15题及其他正文一直存在，原HTTP200来源回复完整返回19题；修复题号/覆盖提取后严格校验并本地重放，旧失败attempt保留，没有重新发送来源整理模型请求。
- 南京：保护原10成功批和全部OCR素材，一次独立素材请求正确归属4/4孤儿。真实旧缓存缺少可选`sourceIssues`数组造成派生失败；兼容修复后本地重放同一有效回复，新增`local_validation_replay/modelCall=false`，原failed attempt和审计不改。19题来源恢复。第8题6图完整，但重复、位置及单图A–D指代未清，4条blocking已保存，未外呼生成教学稿，留置计入needs_review；不能称直接学生布局通过。

南京初稿q1/2/3的invalid_json随后经既有一次Qwen复核恢复有效稿；这不是额外重跑generation，也不将格式失败算作数学错误。最终另有q18生成失败，保留原响应和接口证据。

## 独立核验口径

原先冻结的30道固定题不换样。当前26道有签名绑定的有效候选：完整数学23/26、课堂内容21/26、已知静态格式检查23/26、数学×课堂内容/已知格式×来源合并18/26。15道有明确答案判定，15道正确；不能据此声称26道答案全部已核正确。其余4道为济南3题及南京q8无有效教学候选，保持unknown。

数学完整性采用显式`mathematicalSolutionValid`或`mathCorrect && proofComplete`，不把raw mathCorrect当答案率。候选canonical SHA与源SHA/真实paperIndex共同绑定。南京q16明确采用不可变wave02：主数学/证明成立，但末尾校验突然使用未定义的cosh/sinh记号，课堂需修订；不是原题新定义超纲。固定样本已有2个ready数学/来源漏检，额外定向旧审计另列，不能说全部已知漏检仅2个。未扩大样本外放行。

静态扫描仅覆盖已说明的格式类别，未命中不代表全面UI通过。南京q2/q16实际RichText抽查使用原字符串、MathML正常，双转义疑虑已撤销；q8实际组件1440/390源图回归仍确认布局阻断。报告自身KaTeX成功不能替代应用验证。

## 工程与耗时

阶段1观察JSON的原子替换遇到WinError5；同owner已drain并完成保护核对，后续纯本地收尾保留错误ledger，不重发业务。阶段2/3仅对相同临时文件的短暂Windows替换错误做有界重试，不重试模型调用。

工程排查、回归及构建确认放在继续恢复前，造成恢复空档；不能把这些时间都归因模型。南京Qwen q3实际232.770秒、报告reasoning_tokens=10378，q2实际75.976秒、reasoning_tokens=3595；长耗时与大量模型思考输出同时出现，也不能排除排队/生成速度。报告按真实UTC后台窗口、间隔及逐请求transport分列，不把并发HTTP耗时求和当总墙钟，只展示用量计数，不展示内部思维。

## 证据

- [本机完整证据目录](C:/Users/mrzys/AppData/Roaming/fun.mrzys.tutor/maintenance/source-four-recovery-20261025-01)
- [终态报告](C:/Users/mrzys/AppData/Roaming/fun.mrzys.tutor/maintenance/source-four-recovery-20261025-01/四卷来源修复后-十卷完整流程实测报告.html)
- [终态分析](C:/Users/mrzys/AppData/Roaming/fun.mrzys.tutor/maintenance/source-four-recovery-20261025-01/source-four-analysis.json)
- [阶段3安全核对](C:/Users/mrzys/AppData/Roaming/fun.mrzys.tutor/maintenance/source-four-recovery-20261025-01/stage3-final-safety-verification.json)
- [报告浏览器QA](C:/Users/mrzys/AppData/Roaming/fun.mrzys.tutor/maintenance/source-four-recovery-20261025-01/source-four-report-browser-qa.json)：1440×1000、390×844，8张截图、13项检查通过；仅证明本报告可读。

旧报告与已冻结审计保留。未提交、未推送，不修改README或其它既有脏文件。
