# 离线维护工具

主应用在 `desktop/`。这里没有网页服务，也不应启动认证或本地 HTTP API。

| 工具 | 用途 |
| --- | --- |
| `build-desktop.mjs` | 根构建命令，检查桌面前端和 Rust |
| `export-desktop-bank.mjs` | 从显式指定的旧库只读导出共享白名单及已校验素材，不导出个人记录 |
| `export-desktop-annotations.mjs` | 只读导出题目标注，核验版本与哈希 |
| `export-desktop-supplement.mjs` | 从明确指定的本机共享题库只读导出已发布新增题、内嵌素材和原始发布凭据；不打开个人库，输出不可覆盖 |
| `prepare-legacy-exam-bundles.mjs` | 准备明确来源的旧整卷材料，不冒充真实文件上传流程 |
| `run-teaching-term-pipeline.mjs` | 显式生成独立教学稿，DeepSeek生成，术语命中时由Qwen思考模式复核一次；可显式开启格式失败复核，保存各阶段原请求及响应；不写题库 |
| `run-teaching-quality-workflow.mjs` | DeepSeek生成，合并格式、不完整、术语、显示及模型疑点触发一次Qwen思考模式复核；含KaTeX检查，不写题库 |
| `lib/integrity.mjs` | 迁移工具使用的规范 JSON 与哈希，不进入浏览器 |
| `tests/` | 模拟隔离维护回归，执行 `npm run test:tools` |

迁移 JavaScript 仅依赖 Node.js 24 内置模块，不自动读取或迁移用户数据库，也不使用旧项目凭据。教学维护管线另外使用Windows自带PowerShell/DPAPI读取明确指定的本机模型配置；综合质检复用桌面已有的KaTeX进行公式显示检查。均不需要Python，不进入桌面运行包。
运行前应核对输入路径与输出目的地；开发者维护动作不属于普通用户工作流。

`process-textbooks.py`、`extract-paper-text.py`、`build_gaokao_docs.py` 和
`verify_pedagogy_analysis.py` 是历史教材／研究资料准备脚本，按各自输入与依赖使用。
它们不参与桌面构建、启动或 PDF 输出。

## 教学术语管线

```powershell
node scripts/run-teaching-term-pipeline.mjs --inputs C:/explicit/questions.json --output-dir C:/explicit/new-run
```

输入为数组，每项包含精确 `questionId`、可选 `sampleNumber`、`originalMaterial`（或旧维护导出的 `payload`）；材料内的 `questionId` 必须一致。只发送该材料，不自动发送输入项中的旧标注等其它字段。调用前自行确认实际题干和必要图表完整，不能把文本里的素材路径当作模型已经看见图片。

默认读取 `%APPDATA%/fun.mrzys.tutor/model-settings.json`，也可用 `--model-settings` 明确指定。生成固定使用已保存的 DeepSeek Flash/high 配置，优先匹配的当前项，否则要求唯一匹配；先请求 DeepSeek `/models`，未返回所选模型就停止。

命中后才初始化独立的千问 AI 平台复核客户端，固定地址 `https://maas.qianwenaiapi.com/compatible-mode/v1`、模型 `qwen3.8-flash`、`enable_thinking=true`、默认正文额度 `max_tokens=32768`。先选择同一设置文件里地址、模型与 `reasoningEffort=on` 均匹配的已保存项：优先匹配的当前项，否则要求唯一匹配；没有匹配项才从用户授权的显式离线 `~/.agent.env` 读取唯一的 `QWEN_API_KEY`，可用 `--qwen-agent-env <file>` 指定文件。匹配项歧义、解密失败或无可用密钥时保留复核失败，不改用其它项或 DeepSeek。环境文件仅按字面读取该变量，不执行文件、展开变量或继承 DeepSeek 密钥；此来源不接入正式应用。

复核客户端首次命中后请求千问平台自身 `/models`，确认真实列表含该模型；一次运行只查询一次，失败也不重复查询。没有命中时不读取 Qwen 凭据或环境文件，不请求其模型列表或补全接口。不切换或保存应用设置。正式应用仍仅在 Rust 调用模型。

输出目录必须不存在；默认3路并发（`--concurrency 1..4`），每题由 DeepSeek 生成一次、术语命中时由 Qwen 复核至多一次，没有自动重试、循环或 DeepSeek 复核兜底。失败保留已有原稿及审计；再次执行需显式指定新的目录和输入范围，不能将失败首稿静默标成最终稿。

可显式追加 `--recover-format`：仅在生成阶段正常结束且有完整原始正文、但JSON或字段合约失败时，调用一次格式定向语义复核。默认关闭，历史运行次数及口径不变。网络失败、输出截断、术语复核自身失败不触发这一步；格式复核后仍失败也不循环。复核提示要求独立核算原题、检查条件与课堂表述，并非只修JSON。

格式复核请求与响应分别保存到 `format-review-requests/`、`format-review-responses/`，摘要单列其次数和用量，不将其冒称首稿生成成功。结构合格稿保留在 `recoveredResult`；模型提示材料疑点、内容不完整、术语或显示格式残留时标为 `needs_review`，保留 `needsReviewReasons` 且不设置可用的 `finalResult`。`reviewed_no_known_flags` 仅表示没有这些已知标记，不能当作独立数学核验或教师审核。纯函数模块 `lib/teaching-format-recovery.mjs` 也可显式接收旧失败稿，复核旧稿不会冒称重新生成过首稿。

词典见 `resources/teaching-term-triggers.json`，规范见[设计说明](../docs/design/teaching-term-pipeline.md)。命中只表示需要查看原句，不证明超纲；无命中不表示解答正确。模型最终结果与扫描结论分别保存，不自动替换词语、不改变原题、知识关联、审核状态或冻结成卷。

## 教学综合复核工作流

```powershell
node scripts/run-teaching-quality-workflow.mjs --inputs C:/explicit/questions.json --output-dir C:/explicit/new-run --concurrency 4
```

输入、模型配置、密钥保护与目录约定同上。只发送明确提供的原材料，不附输入项的旧标注；DeepSeek 生成、规则命中后 Qwen 开启思考复核一次，各自请求对应服务商模型列表。结构不合约、不完整稿、术语、公式显示和模型疑点合并后每题最多复核一次；网络失败、截断或复核残留不循环。正常稿不额外调用。原始JSON、结构合法候选和无已知标记的最终稿分别保存，`ready_candidate` 不表示独立数学验证或教师审核。

默认执行静态显示检查和KaTeX渲染检查；依赖不可用时明确失败。字面换行转义、控制字符或破损公式只标记，不猜修。`lib/teaching-display-normalize.mjs` 可在显式保存副本时将配对正确的 `\\(...\\)`／`\\[...\\]` 分隔符转换为桌面使用的美元分隔符，数学内容和模型原稿不变；有硬显示问题时拒绝此适配。不要把该显示适配称作模型纠错。

入口只生成离线候选。独立抽查、内容问题的具体反馈、质量门槛及用户授权后的题库事务写入是另一步维护，详见[工作流与门槛](../docs/design/teaching-quality-workflow.md)。正式知识UID、原题／参考及冻结试卷不由这个入口修改。

两个教学维护入口均可显式追加 `--method-references algebra,functions`，将[方法参考](../docs/design/math-teaching-method-hints.md)中选定板块真正附加到生成与复核的系统提示词；术语入口开启格式复核时也附加同一参考。默认不附加，空列表逐字保留原提示词；不按题目自动分类，也不强制模型采用某种解法。支持 `algebra`、`sequences`、`functions`、`analytic_geometry`、`trigonometry`、`vectors_geometry`、`probability_statistics`、`sets_logic_complex`，未知或重复 ID 在访问模型服务前拒绝。

输出 `method-references.json` 保存实际选定文本及来源文档哈希，`protocol.json` 保存板块 ID 与参考快照哈希；最终发送的系统提示词仍保存在各阶段请求中。记录只证明参考已发送，不能据此声称模型采纳或教学质量提高。


两入口的 `protocol.json` 显式记录生成与计划复核模型；首次触发复核时另存实际 `review-profile-public.json` 和 `review-models-public.json`。逐阶段响应记录实际 provider/model 及公开配置，`summary.json.providers` 分开统计两阶段的模型列表次数、补全请求审计数、服务商报告用量和用量未知请求数。生成用量与复核用量不能混作单模型成本；复核初始化失败不冒称已发出补全请求。请求正文及其哈希保留，但不保存认证头、密钥或私密思考正文。

本流程只定位已知机械问题与生成候选；规则无命中、模型复核通过均不等于独立数学核验。默认不附加八板块方法参考，仍可显式选择；未解决的题保留待复核，不因已知问题占比小而自动放行。
