# 仓库整理 · 2026-10-12

- 统一归档本轮组卷、导入审核、难度建议、管理员管理、PDF、品牌和交互改动。
- 删除 output/ 生成的 PDF、截图及验收 JSON，tmp/ 旧脚本、提取文本和 UI 验证页面，Python 缓存及临时 review payload。
- 下载题源保留本地并忽略；保留题库 manifest 引用且已跟踪的基准 PDF、版本化题包、来源审核证据和维护脚本。
- .env、SQLite、.tutor、代理本地记忆不提交；dist 和 node_modules 继续保留供本地运行。
- 根目录 design-qa.md 归入 docs/validation/sidebar-design-qa.md；README 更新运行、账号隐私及仓库管理说明。
- 部署 smoke 根据临时克隆库是否已有账户判断新注册角色，不再假设空用户表。
- 提交前检查未发现密钥或个人邮箱；构建、题库核验、暂存区空白检查通过。
- 首轮全量测试 337 项中 5 项因本地 Python 缺 svglib 失败；按 requirements-pdf.txt 补齐依赖后，12 项 PDF/计分测试通过，并重新执行全量测试。
- 最终全量测试：337 项全部通过。
