# 导入阅读精简回归

2026-10-21，版本 0.1.30。以下为模拟开发回归，不代表真实教师使用成效或模型准确率。

## 变更

- 导入 `QuestionBody` 显式隐藏来源，题库及正常组卷默认保持来源展示。
- 小问尊重原文（Ⅰ）、（Ⅱ）等标题，仅抑制重复生成的界面前缀，不修改正文或答案对应，旧 PDF 输出分支不变。
- 仅选择题要求核对选项；填空、解答的人工作业文案为“题干与小问”。原卷缺答案解析不是模型检查缺陷，但源有内容却丢失仍阻断。
- 合格题隐藏逐题状态和意见卡片；疑点默认一条简短摘要，完整旧意见与审计折叠保留，不改变服务器入库资格。旧疑点可显式重新检查。
- 模型导入和重检提示按题型与实际原卷字段检查，要求具体问题引用原文、说明位置和补正动作；保留同次导入请求，不追加常规逐题请求。

## 证据

- TypeScript／Vite 构建通过；17 项前端规则测试通过。
- 最新完整 Rust 回归：238 通过、0 失败、1 项本机 Office 集成测试忽略。
- 真实 Rust＋隔离 SQLite＋本机模拟服务＋Playwright：来源显示边界、单份小问标题、数学括号、填空／选择题检查及编辑、摘要折叠、统一入库资格、导航、390px 及控制台均通过。
- 实际第 15 题的只读渲染验证通过，个人库哈希不变。实际第 12 题的旧错误意见只读诊断，不修改真实用户记录，也未自动放行。
- `tauri build --no-bundle` 成功，仅生成 EXE，未制作安装包。
- 保留 `tutor-desktop-0.1.30.exe`，39,265,792 字节，SHA256：`0C949FEE693F7BE839A6CED693106A83243CD1014AEBB8A6E4965F28F6E03BB4`。
- 学生管理及学情同步仅形成设计草案，本轮未实现页面、数据表或向模型传递学情。

临时证据不提交到仓库：

- `C:/Users/mrzys/AppData/Local/Temp/tutor-review-ui-lNT8K2/refinement-ui-result.json`
- `C:/Users/mrzys/AppData/Local/Temp/tutor-part-label-x3mm39/result.json`
- `C:/Users/mrzys/AppData/Local/Temp/tutor-import-refinements-final-test.log`
