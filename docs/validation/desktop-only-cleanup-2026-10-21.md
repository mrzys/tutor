# 桌面单端仓库清理验证

日期：2026-10-21。用户要求提交当前桌面迁移成果，并去掉旧网页端。
本记录为工程回归，不代表真实教师使用或教学效果验证。

## 清理边界

- 唯一应用为 `desktop/`；移除根 `web/`、`src/`、旧网页测试、Node/Nest 服务、部署配置和根 Vite 入口。
- 桌面依赖的 token、富文本和来源显示迁入 `desktop/src/`；复制时与原工作区文件逐字节一致。
- 保留题库／标注导出、整卷来源准备和资料工具；离线工具哈希依赖及回归移入 `scripts/`。
- 根命令仅转发桌面开发、构建和测试；根锁文件不再包含旧网页运行依赖。
- 保留教材、来源台账、历史决策和验证文档；个人库、题库、原件、旧成卷和既有 EXE 未修改。

旧源码在删除前备份至仓库外：
`C:/Users/mrzys/AppData/Local/Temp/tutor-web-retirement-86ffd927fe6b4977bdbb4e43b824ffd9.zip`。
备份只包含旧源码及配置模板，不含真实环境密钥或数据库。旧已提交版本仍可从 Git 历史追溯。

## 自动检查

- `npm run build`：Solid 类型检查、Vite 生产构建和 Rust 桌面检查通过。
- `npm test`：前端 30 项通过；隔离 Rust 251 项通过、0 失败、1 项显式 Office 集成检查跳过。
- `npm run test:tools`：22 项通过。
- 暂存文件检查：未包含数据库、EXE、日志、构建目录、真实 `.env` 或调试截图；强密钥模式扫描无命中。
- Git 索引中不再包含旧 `web/`、根 `src/`、旧 `tests/`、`deploy/` 或 `public/` 运行文件。

这些检查使用隔离回归数据，不访问真实 OCR／模型服务或个人数据库。本轮未重新生成 EXE。

## 浏览器复查

通过桌面自身 Vite 入口新加载，使用真实 Rust 调试驱动和临时数据目录，未使用旧网页服务。
组卷输入／原生光标／撤销／换行／`@` 键盘选择 9 项通过；仅答卷保存、选填原卷及日期 6 项通过；
题库公式、来源详情、1440／390 宽度及加载检查 5 项通过。控制台、模块、请求失败及 HTTP 错误均为零。
本次种子 358 题没有学生题面图片资产，因此未声称验证真实题图加载。

原始证据均在仓库外临时目录：

- `C:/Users/mrzys/AppData/Local/Temp/tutor-student-layout-Co6KsZ/caret-interaction-result.json`
- `C:/Users/mrzys/AppData/Local/Temp/tutor-student-work-PTqpJ0/optional-source-ui-result.json`
- `C:/Users/mrzys/AppData/Local/Temp/tutor-student-layout-zJ6bVS/cleanup-bank-result.json`

1440／390 题库与上传弹窗截图保存在相应临时目录；主代理复查题库与两种宽度上传截图，未发现清理引入的排版回退。
