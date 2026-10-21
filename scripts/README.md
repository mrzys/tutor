# 离线维护工具

主应用在 `desktop/`。这里没有网页服务，也不应启动认证或本地 HTTP API。

| 工具 | 用途 |
| --- | --- |
| `build-desktop.mjs` | 根构建命令，检查桌面前端和 Rust |
| `export-desktop-bank.mjs` | 从显式指定的旧库只读导出共享白名单及已校验素材，不导出个人记录 |
| `export-desktop-annotations.mjs` | 只读导出题目标注，核验版本与哈希 |
| `prepare-legacy-exam-bundles.mjs` | 准备明确来源的旧整卷材料，不冒充真实文件上传流程 |
| `lib/integrity.mjs` | 迁移工具使用的规范 JSON 与哈希，不进入浏览器 |
| `tests/` | 模拟隔离维护回归，执行 `npm run test:tools` |

上述 JavaScript 仅依赖 Node.js 24 内置模块，不自动读取或迁移用户数据库，也不使用旧项目凭据。
运行前应核对输入路径与输出目的地；开发者维护动作不属于普通用户工作流。

`process-textbooks.py`、`extract-paper-text.py`、`build_gaokao_docs.py` 和
`verify_pedagogy_analysis.py` 是历史教材／研究资料准备脚本，按各自输入与依赖使用。
它们不参与桌面构建、启动或 PDF 输出。
