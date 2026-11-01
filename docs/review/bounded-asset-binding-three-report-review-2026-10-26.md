# 题图绑定修复-三卷继续处理与课堂抽查报告的 review（2026-10-26）

评审对象：《题图绑定修复：三卷继续处理与课堂抽查报告》（试验目录 `C:\Users\mrzys\AppData\Roaming\fun.mrzys.tutor\maintenance\bounded-asset-binding-three-20261026-01\`）。
评审方式：报告全部可核对声明逐条对照该目录原始记录（`final-metrics.json`、`approval-summary.json`、`extended-asset-placement-review.json`、`independent-math-paper0{1,2,3}-*.json`、`continuation-02/`、`rendered-assets-final-1793020145042/visual-review.json`、`engineering-verification.json`、广安17 原始转录响应）。

## 一、核心数据核实：主表与叙事全部属实

| 报告声称 | 原始记录 | 结论 |
| :--- | :--- | :--- |
| 来源 3/3、58 题、30 批次；57 通过、1 待核（广安18 表头方向） | `final-metrics.json` `sourceFidelity: {total:58, pass:57, concern:1}`；三卷 `sourceSuccessfulBatches` 各 10 | ✅ 属实 |
| 程序终态 41/14/3、eligible 37 → 独立回填后 39/16/3、eligible 36 | `programTerminalBeforeIndependentHolds` / `latestAfterIndependentHolds` | ✅ 属实 |
| POST 49 次（来源1+生成30+复核18）、5 次连接超时、44 份有 usage 共 498,934 tokens（含 2 份 HTTP200 JSON 失败） | `httpUsageLedger`: `modelPostAttempts:49`；`byKind` 三段 1/30/18；timeout 5 次；`usageReportedRequests` 1+27+16=44；`total_tokens:498934` | ✅ 属实 |
| 生成中位 51.3s/最大 91.1s；复核中位 38.2s/最大 96.5s | `byKind.elapsedMs`: 51277/91117；38162/96540 | ✅ 属实 |
| 5 次超时均约 21 秒，非"思考 120 秒" | ledger 5 条 timeout 全部 21053–21089ms；广安19 transport 单事件 21064ms、`isConnect:true`、OS 错误 10060（`independent-math-paper01-q19-postreview.json`） | ✅ 属实 |
| token 细分：来源 6,544 + 生成 350,948 + 复核 141,442 = 498,934；reasoning 311,256 为 completion 子项 | `byKind` 各段 `reportedTokenTotals` 相加吻合；`countingNotes` 第 4 条明示子项不重复相加 | ✅ 属实 |
| 首阶段 894.3s；第三卷生成前模型目录连接超时；第二阶段 1024.2s；合计 1918.5s | `execution-summary.json` 894.335；`progress.json` paper3 "获取模型列表超时"；`continuation-02/execution-summary.json` 1024.175 | ✅ 属实 |
| 六图显式批准：广安5、16；天津9、17；玉溪10、17；审批另存、原始响应不改 | `approval-summary.json` `approvedCount:6`，六条 approval 含 asset/manifest/response 哈希与 `user_authorized_agent_review` 作者；`four-asset-placement-review.json` 4 处 + `extended-asset-placement-review.json` `newlyDiscoveredApprovedFigureCount:2` | ✅ 属实 |
| 唯一新增真实来源请求（广安17）没有题图，不能宣称模型已自动放对六图 | ledger `source_transcription` 仅 1 条、`questionIds:[...-q17]`；其原始响应正文 0 处 asset/figure/image 声明（已直接核对该 response.json） | ✅ 属实 |
| 保护核对：167 原始文件、14 旧批次（32 题）、27 旧 ready 全部未变 | `httpUsageLedger.protected`：三项 `changed*` 均为空数组、`allUnchanged:true` | ✅ 属实 |
| 独立抽样 15 题：6 题可直接参考（广安1、天津2/9/17/19、玉溪6）；玉溪16 补一行判别式；其余 8 题不能直接用 | `independent-math-paper01-final.json`（usable=1：广安1）；`paper02Initial`（usable=4：2/9/17/19，且 q20-postreview `unchangedOtherFour` 哈希不变延续）；`independent-math-paper03-final.json`（`fullClassroomNoEditPassQuestions:[6]`、`minorProofAddOneLineQuestions:[16]`） | ✅ 属实 |
| 天津20：Qwen 未修掉 cosh，还新引入导数符号错误 | `independent-math-paper02-q20-postreview.json`：`unremoved_undefined_cosh` + `new_wrong_g_derivative_sign`（含 d=1 数值反例 0.1246 vs 0.6112）、`qualityChange:"degraded"` | ✅ 属实 |
| 玉溪10：教学层误撤材料疑点，但来源层仍阻断，非危险放行 | `independent-math-paper03-final.json` q10：`teaching_stage_false_clear` + `whole_question_correctly_held_by_source_review` | ✅ 属实 |
| 3 个追加标记事件未调用模型、未改候选 | `independentHoldEvents.events`：玉溪10、玉溪16（ready→needs_review）、天津20（needs_review 不变），`modelCallsAdded:0` | ✅ 属实 |
| 工程与 UI 验证（115 前端 / 590 Rust 测试、六图桌面+手机解码、滚动可达、玉溪17/18 重复题号仅显示层消除、报告 QA 884 公式 0 错误） | `engineering-verification.json` 全部字段一致；`rendered-assets-final-1793020145042/visual-review.json` 28+7 张截图直接查看、`necessarySourceFiguresPresentWithMatchingHash:true`、`duplicateYuxi17_18PrefixesObserved:false` | ✅ 属实 |

诚实性边界同样到位：报告明确区分 39/58 是程序状态非数学正确率、15 题为目的性样本非随机总体、审计者参与工程非严格双盲、9 次角色列表检查无逐次回执单独列出（`reconstructedTotalHttpAttemptsIncludingRoleCatalogChecks:59`）、`reportIsNotPDFValidation:true`。这套表述与 AGENTS.md 的边界约定（不冒称教师审核/正确率/自动冷卷基准）一致，无越界表述。

## 二、需要修正或补充的点（按重要度排序）

### 2.1 「6/15 可直接参考」含 2 道题库已存在题，净新增可直接参考为 4 道

> 被质疑原文（报告「独立核对：哪些还需要处理」节）：「6题可直接参考：广安1、天津2/9/17/19、玉溪6。」

报告自己的逐题状态表已披露：广安1 与天津2 的程序记录原因均为**「此题已存在于题库，不能重复入库。」**。即这 2 题的教学稿可用，但**不构成本轮对题库的任何新增**——同题内容此前已在库。净新增可直接参考的只有 4 道（天津9/17/19、玉溪6），外加玉溪16 补一行判别式。这与上一轮评审 B-q07（6 份候选按题净增 5 道）是同一类计数口径问题：读者从标题数字「6 / 15」会高估本轮净产出。建议在标题数字旁注明「其中 2 题为库内已存在题」。

值得肯定的是：**「整题 eligible 36」这一口径已经剔除了重复题**（`latestAfterIndependentHolds.papers` 的 eligible 名单中广安 1/2、天津 1/2 均不在列），所以入库视角的 36 是干净的——报告只是没有把这个区别在「39 ready」与「36 eligible」之间写明。

### 2.2 「新合同已通过真实本地HTTP回归」缺可追溯的工件指针

> 被质疑原文（报告「修复了什么」节）：「新合同已通过真实本地HTTP回归，但本轮唯一新增的真实来源请求（广安17）没有题图……」

这句话是 `make-report.mjs` 第 51 行的硬编码文案；本目录内没有任何工件指明**哪些**测试用例以真实本地 HTTP 驱动了有界位置合同（`engineering-verification.json` 只有 `rustTests: {passed: 590}` 的总数与日志哈希，无用例清单；`rendered-assets-validation-plan.json` 覆盖的是 UI 渲染链而非来源合同回归）。按本仓库「开发者组卷日志……便于逐步排查」的约定，该断言应给出测试名清单或聚焦运行的日志摘录，否则它和报告其余处处可回溯的风格不匹配。这是本报告唯一一处「说了但没有留证据指纹」的声明。

### 2.3 广安19 的状态原因把同一条超时消息显示了两次

> 被质疑原文（报告逐题表，广安19）：「连接模型服务超时（请求总预算 120 秒），尚未收到响应；请检查网络后显式重试。；连接模型服务超时（请求总预算 120 秒），尚未收到响应；请检查网络后显式重试。」

ledger 中广安的复核 timeout 只有一次（21064ms，`continuation-02` 段），`statusTransition.reviewCallsBefore:0 → After:1`，transport 记录也只有单一事件。两条完全相同的超时文案来自程序原因聚合的重复追加，报告原样照登。属显示层瑕疵（与上一轮发现的句段接缝重复同族：合并/聚合层缺少去重），建议在 reason 聚合处按 (questionId, errorCode, 时间窗) 去重。

### 2.4 小问题：两个图片计数的口径未说明

报告 QA 记录 `imageReferencesDecoded: 11`（15 张抽查卡内解码的图片引用），而正文断言「六图……引用一次」（导入 UI 中六张批准题图各一次）。两个数字各自成立（前者含玉溪卷公式碎块等原图素材），但同页并存且未互相说明，读者会拿 11 去质疑 6。建议在 QA 块加一句口径注。

## 三、结论

这份报告的可信度显著高于前几轮：所有可核对声明（数量、时间、token、哈希、逐题状态、独立判定）与原始记录**零偏差**，且对自身局限（样本非随机、非双盲、超时非思考、误撤但被来源层拦截）的披露完整、克制。四条修正均为表述精度问题而非事实错误：① 标题「6/15」应标注含 2 道库内已存在题（净增 4+1 行）；② 「真实本地HTTP回归」补测试工件指针；③ 超时消息去重；④ 图片计数口径注。修复落地建议维持报告原文的三类分流（来源/题意核对 → 教师；实质推导缺陷 → 核算重写；记号/局部证明 → 有界补充），其中「核算重写」若走模型仍须按既有边界显式授权、单独记账，不作为自动回退。
