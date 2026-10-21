# 智教

面向私教的本地桌面应用，使用 **SolidJS + TypeScript + Tauri 2 + Rust + SQLite**。
当前只有桌面端，不提供网页服务、登录、注册或账号管理；首次使用设置本地昵称即可。

## 功能

- 组卷：需求确认 → 题位规划确认 → 真实题库选题 → 编辑草稿 → 确认成卷，缺题保留并说明。
- 题库：教材与知识点导航、筛选、手动组卷篮，以及 PDF／DOCX／文本导入和审核。
- 预览：完整学生卷／教师卷、公式、图片和表格渲染，使用 Windows WebView2 输出 PDF。
- 学生：基础资料、答卷原件、后台 AI 批改与历史记录，教师可按需修正，不自动推断掌握度。
- 设置：多套本机模型配置与独立 PaddleOCR 配置，密钥由 Windows DPAPI 加密保存。

外部练习可仅填写名称并上传答卷，原试卷选填；缺少必要题干或依据时保留“暂无法判断”。
模型请求只在用户明确发起时执行，阅读历史不外呼。模型估计与工程回归不代表真实教学效果。

## 开发与验证

Windows 需要 Node.js 24+、Rust 1.90+、C++ 构建工具及 WebView2。
在仓库根目录执行：

```powershell
npm ci
npm run desktop:install
npm run dev
```

Tauri 自动启动 `1420` 端口的 Vite 开发服务；正式 EXE 不启动 Node 或本地 HTTP API。

```powershell
npm run build
npm test
npm run test:tools
npm run desktop:build
```

- `build`：Solid 类型检查、界面生产构建及 Rust 检查。
- `test`：桌面前端规则／渲染数据回归与隔离 Rust 测试。
- `test:tools`：离线题库迁移和整卷来源转换回归，不使用真实个人数据。
- `desktop:build`：仅生成 `desktop/src-tauri/target/release/tutor-desktop.exe`，不制作安装包。

开发版可使用根 `.env` 的模型配置，示例见 [.env.example](.env.example)。正式版只使用本机设置，
不读取或打包开发密钥。普通 PDF／DOCX 试卷导入前须配置模型和独立 PaddleOCR；DOCX 转换需要
已安装 Word／LibreOffice，否则先导出 PDF。桌面运行与 PDF 输出不依赖 Python。

## 本机数据

Windows 默认保存在 `%APPDATA%/fun.mrzys.tutor/`。个人记录使用 `personal.sqlite`，
共享题库使用 `question-bank.sqlite`；导入原件、答卷及输出附件分别归档。关闭应用后备份整个目录。
用户已选择从空白个人数据开始，旧 `.tutor/` 和网页个人数据库保持原样，禁止自动合并或清空。

## 仓库结构

| 路径 | 用途 |
| --- | --- |
| `desktop/src/` | SolidJS 界面、共享 token、来源显示和富文本渲染 |
| `desktop/src-tauri/` | Rust、Tauri、存储和模型调用 |
| `desktop/resources/` | 版本化题库种子、标注和难度口径 |
| `desktop/tests/` | 桌面前端回归 |
| `scripts/` | 构建入口和显式离线迁移／资料准备工具 |
| `data/`、`materials/` | 来源台账、教材与研究资料，非运行数据库 |
| `docs/` | 产品决策、设计和验证记录 |

旧网页、Node 服务、网页测试及部署配置已退休，共享代码已迁入桌面目录；历史实现可从 Git 追溯。
旧验证记录保留其发生时的路径和命令，不作为当前运行方式。

详见 [桌面版说明](desktop/README.md)、[架构决策](docs/adr/README.md)、
[界面约定](docs/design/tutor-ui.md)和[协作约定](AGENTS.md)。
