# Tutor v1

当前已完成 S3-01～S3-03，并提供 S3-04 的工程功能：读取真实题目、确认需求与蓝图、局部调整草稿、保存不可变成卷、分别生成学生版与教师版 A4 PDF。当前用户实际使用后是否愿意采用，仍待反馈。

需要 Node.js 24 或更新版本，无须数据库或 API 密钥。PDF 输出另需 Python 及中文 TrueType 字体。在仓库根目录执行：

```powershell
npm ci
$env:TUTOR_PYTHON = (Get-Command python).Source
& $env:TUTOR_PYTHON -m pip install -r requirements-pdf.txt
npm run build
npm start
```

打开 <http://127.0.0.1:4318>。开发模式使用 `npm run dev`，打开 <http://127.0.0.1:5173>；开发模式同时启动 API，不要与 `npm start` 同时运行。

上面的 `TUTOR_PYTHON` 指定安装依赖及生成 PDF 使用的同一个 Python。也可把该变量设为其他解释器的绝对路径；未设置时，程序先查找本机 Codex 捆绑运行时，再使用系统 `python`（Windows）或 `python3`。Windows 默认尝试 `C:/Windows/Fonts/simhei.ttf`；其他环境或字体可通过 `TUTOR_CJK_FONT` 指定中文 `.ttf` 文件的绝对路径，环境变量需在启动服务前设置。网页公式使用本地 KaTeX，PDF 公式使用 MathJax SVG 与 ReportLab。

使用流程：

1. 查看需求与知识前提，生成并编辑蓝图，确认后从真实题库选题。
2. 在草稿中换题、锁定、增减题、调整题分及小问赋分，或更正知识与来源基线。自动换题跳过锁定题，直接操作锁定题仍可执行。无合格备选或读取失败时保留现题。
3. 查看实际题数、分值、未知、缺项及计划差异，确认并保存成卷。成卷内容固定；后续调整使用“派生新草稿”。
4. 分别生成、下载并检查学生版和教师版 PDF。一版失败可单独重试，另一版和成卷保留；“未完整”文件附带具体缺项。
5. 实际使用后填写是否愿意采用、原因与手工修正情况。未填写前保持待验证，开发检查不代替用户反馈。

界面采用可见的集合专项预设，无模型调用。默认从 18 道已就绪题中按具体任务、来源、允许解法与重复关系选取 10 题，6×8+2×10+14+18=100 分。候选不足会保留空位；难度没有独立估计时显示未知，调整目标难度不会编造估计或改写题目。默认首稿中 007、020、034 缺建议评分资料，教师版如实标记；学生题面仍可使用。

两种运行模式共用 `.tutor/`，该目录不提交 Git。备份和迁移请保留整个目录：

| 目录 | 内容 |
| --- | --- |
| `.tutor/drafts/` | 草稿内容、修订、锁定、操作及基线历史 |
| `.tutor/papers/` | 不可变成卷、确认摘要、题面/教师资料版本及冻结素材 |
| `.tutor/outputs/` | 两版 PDF 与各自输出状态、校验记录 |
| `.tutor/feedback/` | 用户填写的实际使用反馈 |

题库命令与工程检查：

```powershell
npm run bank:list
npm run bank:get -- tutor-set-001 --student
npm run bank:get -- tutor-set-041
npm run bank:get -- tutor-set-050
npm run bank:check
npm test
```

`list` 显示全部 50 个来源单元及实际处理状态：首批 18 题就绪，32 题待整理。先查询返回的 `contentVersion`，再用 `--version content-…` 读取指定内容；还可用 `--teacher-version teacher-…` 固定教师资料版本。版本不匹配会报错，不会偷偷改读最新版本。`--student` 仅返回学生题面及身份/版本，不返回教师答案或核查笔记。

数据与核查说明见 [S3-01 交付记录](docs/validation/s3-01-question-data.md)；首稿选题及标杆差异见 [S3-02 交付记录](docs/validation/s3-02-assembly-draft.md)；局部调整见 [S3-03 交付记录](docs/validation/s3-03-draft-editing.md)；成卷与两版输出、当前验证边界见 [S3-04 交付记录](docs/validation/s3-04-delivery.md)。完整验收要求见 [MVP 开发任务](docs/tasks/mvp-implementation.md)。
