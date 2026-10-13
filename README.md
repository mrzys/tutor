# 智教

MVP 界面使用 [DESGIN.md](DESGIN.md)，具体应用见 [Tutor UI 说明](docs/design/tutor-ui.md)。已接通 React + Vite + Lucide、NestJS、AI SDK 与 SQLite，迁移边界见 [ADR-0004](docs/adr/0004-mvp-application-stack.md)。

当前已完成 S3-01～S3-03，并提供 S3-04 的工程功能：读取真实题目、确认需求与蓝图、局部调整草稿、保存不可变成卷、分别生成学生版与教师版 A4 PDF。当前用户实际使用后是否愿意采用，仍待反馈。

MVP 新建用途聚焦课后巩固、专项训练、学情诊断，三种用途共用工作台，分别强调授课贴合、专项递进和清晰检查点。诊断练习由教师结合学生答卷判断，不依赖在线作答系统。旧单元测验及模拟考试记录继续保留原用途。

需求入口先选择教材范围与用途，再用一个输入框补充要求；AI 整理教学目标，教师确认需求后规划蓝图。蓝图默认按题型 Tab 展示逐题安排，教师确认采用后才开始选题。规划与编辑页的流程导航位于标题上方，新建页与成卷页隐藏；查看历史阶段只读，不修改当前试卷。默认已学范围按核实的教材进度推定，练习可以不计分；刷新后可显式继续上次需求。题目目标支持尚待外部分析适配与复核：必须目标关联的题位缺少证据时留空，偏好目标不计为已证实覆盖。详见 [S3-05 任务](docs/tasks/s3-05-teaching-requirements.md)和 [MVP 交付记录](docs/validation/mvp-generative-intake.md)。

需要 Node.js 24 或更新版本。SQLite 自动初始化，无须独立数据库服务；不配置模型也可通过点击完成组卷。PDF 输出另需 Python 及中文 TrueType 字体。在仓库根目录执行：

```powershell
npm ci
$env:TUTOR_PYTHON = (Get-Command python).Source
& $env:TUTOR_PYTHON -m pip install -r requirements-pdf.txt
npm run build
npm start
```

打开 <http://127.0.0.1:4318>。开发模式使用 `npm run dev`，打开 <http://127.0.0.1:5173>；开发模式同时启动 API，不要与 `npm start` 同时运行。

首次打开需要使用邮箱和密码注册。数据库中的首个注册账户自动成为管理员，后续账户为教师；角色由后端事务决定。首位管理员认领升级前的组卷历史，之后各账户的需求会话、草稿、成卷、PDF 和上传记录相互隔离，题库共享。左下角显示邮箱字母头像、邮箱 @ 前的名称与角色；更多菜单提供管理和退出入口，管理员可创建用户与重置密码。邮箱目前作为登录标识，不发送验证邮件。

前端使用路径地址：`/` 新建组卷、`/question-bank` 题库、`/question-import` 上传试卷、`/drafts/:id` 草稿、`/papers/:id` 成卷；`/drafts` 和 `/papers` 查看列表。支持直接打开、刷新及浏览器前进后退，旧的 `?view=`、`?draft=`、`?paper=` 链接自动替换为新路径。生产服务已支持页面路径回退到 SPA 入口；独立部署前端时也需配置相同回退。题库 API 的筛选仍使用查询参数。

在线 AI 整理需要根目录 `.env`，字段见 [.env.example](.env.example)：`LLM_BASE_URL`、`LLM_API_KEY`、`LLM_MODEL`、`LLM_PROVIDER_NAME`。服务启动时读取，修改后重启；密钥仅服务端使用，禁止使用 `VITE_` 前缀或提交到 Git。默认 JSON object + 本地严格校验，支持原生 JSON Schema 的服务可配置 `LLM_STRUCTURED_OUTPUTS=json_schema`。

上面的 `TUTOR_PYTHON` 指定安装依赖及生成 PDF 使用的同一个 Python。也可把该变量设为其他解释器的绝对路径；未设置时，程序先查找本机 Codex 捆绑运行时，再使用系统 `python`（Windows）或 `python3`。Windows 默认尝试 `C:/Windows/Fonts/simhei.ttf`；其他环境或字体可通过 `TUTOR_CJK_FONT` 指定中文 `.ttf` 文件的绝对路径，环境变量需在启动服务前设置。网页公式使用本地 KaTeX，PDF 公式使用 MathJax SVG 与 ReportLab。

使用流程：

1. 查看需求与知识前提，生成并编辑蓝图，确认后从真实题库选题。
2. 在草稿中换题、锁定、增减题、调整题分及小问赋分，或更正知识与来源基线。自动换题跳过锁定题，直接操作锁定题仍可执行。无合格备选或读取失败时保留现题。
3. 查看实际题数、分值、未知、缺项及计划差异，确认并保存成卷。成卷内容固定；后续调整使用“派生新草稿”。
4. 分别生成、下载并检查学生版和教师版 PDF。一版失败可单独重试，另一版和成卷保留；“未完整”文件附带具体缺项。
5. 实际使用后填写是否愿意采用、原因与手工修正情况。未填写前保持待验证，开发检查不代替用户反馈。

需求确认后，默认由 LLM 结合教学目标、现有任务目录和真实候选供给规划蓝图；入口由 AI 建议题型配比，教师可按题型 Tab 调整题位。规则核验题量、分值、边界、目标与重复关系，教师确认蓝图后才从真实题库选题。选题按题型分批，最多两个模型请求并行；界面显示查找候选、AI 比较、去重组合及保存草稿的真实进展。整卷目标覆盖检查由教师按需发起，题目正确性及图表完整性主要在导入审核阶段把关。LLM 不生成题目，不把规划理由当作目标支持或难度证据；失败可重试、取消或主动使用规则预设。练习默认 10 题，计分按用途与教师要求开启；默认掌握初中基础与教材范围之前的内容。候选不足保留空位；难度没有独立估计时显示未知。007、020、034 缺建议评分资料，教师版如实标记；学生题面仍可使用。

版本化集合种子包有 34 个任务预设、45 道可用题。运行期 SQLite 题库还可通过上传解析与管理员审核入库接口扩充：审核后追加真实教材小节、考查任务、知识点映射及来源，不覆盖既有成卷快照。第一、二章定向扩充记录见 [导入与组卷验证](docs/validation/chapter12-bank-expansion.md)。新增题目不自动获得四维目标支持；必须目标缺少已复核证据时仍留空。

两种运行模式共用 `.tutor/`，该目录不提交 Git。备份和迁移请保留整个目录：

| 目录 | 内容 |
| --- | --- |
| `.tutor/tutor.sqlite` | 用户、密码哈希、会话及资源归属，题目、教材目录、知识映射和教研标注，需求会话、调用审计、草稿及其蓝图、成卷、反馈、输出清单；运行期主存储 |
| `.tutor/drafts/`、`.tutor/papers/`、`.tutor/feedback/` | 旧 JSON 导入来源，启动时幂等导入并保留；正式运行不双写 |
| `.tutor/outputs/` | 两版 PDF 文件；旧输出 JSON 清单保留，运行状态写入 SQLite |
| `.tutor/analysis-submissions/` | 外部原始分析及待复核状态，独立于题库与选题证据 |

备份前先停止服务，再复制整个 `.tutor/`，包含数据库及可能存在的 WAL/SHM 文件和输出素材。旧 JSON 损坏会告警并保留，不覆盖已有数据库版本；历史通过左侧“进行中”和“历史归档”查看草稿和已确认成卷。

空库首次启动会核验并导入 `data/` 中的版本化题包、教材目录、知识映射和组卷配置。后续启动和 HTTP 搜索直接读取数据库，不会重新用 JSON 覆盖数据库。题库支持按小节、题型、关键词、难度、能力及核心素养组合进行 SQL 筛选和分页；跨页已选题保留精确版本，生成草稿时再次核验。种子包 45 道题的难度未评估，18 道已有能力与素养教研标注；导入题的难度由当前模型独立建议并保存判断依据，明确属于内容估计而非学生作答实测。待复核能力与素养标注可供检索参考，不自动升级为组卷目标的合格证据。

可用 `TUTOR_STORAGE_ROOT` 和 `TUTOR_DATABASE_PATH` 指定存储目录与数据库。更新种子材料后，先停止服务并备份，再执行 `node scripts/sync-question-bank.mjs` 显式同步题库与配置；它会替换数据库中的题库及目录快照，但保留历史草稿和不可变成卷。`bank:list/get/check` 用于审计源材料，网页查询以 SQLite 为准。

题库命令与工程检查：

```powershell
npm run bank:list
npm run bank:get -- tutor-set-001 --student
npm run bank:get -- tutor-set-041
npm run bank:get -- tutor-set-050
npm run bank:check
npm run blueprint:check
npm run analysis:check
npm test
```

`list` 显示全部 50 个来源单元及实际处理状态：当前 45 题就绪，5 题待处理；其中 27 题为本轮从原 PDF 核对后新增。先查询返回的 `contentVersion`，再用 `--version content-…` 读取指定内容；还可用 `--teacher-version teacher-…` 固定教师资料版本。版本不匹配会报错，不会偷偷改读最新版本。`--student` 仅返回学生题面及身份/版本，不返回教师答案或核查笔记。

数据与核查说明见 [S3-01 交付记录](docs/validation/s3-01-question-data.md)；首稿选题及标杆差异见 [S3-02 交付记录](docs/validation/s3-02-assembly-draft.md)；局部调整见 [S3-03 交付记录](docs/validation/s3-03-draft-editing.md)；成卷与两版输出、当前验证边界见 [S3-04 交付记录](docs/validation/s3-04-delivery.md)。完整验收要求见 [MVP 开发任务](docs/tasks/mvp-implementation.md)。

五册教材提取、旧知识点全量迁移及正文映射见 [教材与知识点](docs/curriculum/README.md)。另从模拟卷收集的 [50 道集合题](docs/validation/set-expansion-50/README.md) 已完成转录与来源核对，仍在 staging 待复核；它们未计入当前 45 道就绪题，不代表界面已经增加可选题量。


## 仓库与本地文件

代码、版本化题库种子、测试、导入维护工具、部署模板及质量记录纳入 Git。下载的补充 PDF、DOCX、扫描图片保留本地；已跟踪且由题库 manifest 引用的两份基准 PDF 继续版本管理。

`.tutor/`、`.env*`（除 `.env.example`）、SQLite 文件和 `.workbuddy/` 是本地运行数据或私有配置，不提交。`tmp/`、`output/`、`__pycache__/` 与日志为可重新生成的验证产物，可定期清理。`dist/` 由 `npm run build` 生成；正在运行服务时保留它，`node_modules/` 由 `npm ci` 安装。PDF/界面验证记录中提及的本地截图和导出文件不随仓库发布。

部署方式见 [部署说明](deploy/README.md)。后续发布保留生产数据库；带宽受限时只上传变更资源，并限制上传速率。
