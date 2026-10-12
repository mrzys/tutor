# 图表材料真实导入验证

验证日期：2026-10-12。使用项目当前配置的 `deepseek-official / deepseek-flash`，通过真实 Nest HTTP 登录、`multipart POST /api/question-imports` 上传两份明确标注的测试材料。没有替换模型，没有调用发布接口。

数据与暂存记录全部位于 `.tutor/chapter12-expansion/visual-storage/`；未写正式题库。接口响应、完整 `llmRun`、提取元数据、文件 SHA-256 与逐格检查保存在 `.tutor/chapter12-expansion/visual-import-http-evidence.json`。

| 材料 | HTTP / 模型调用 | 实际结果 |
| --- | --- | --- |
| 含 3 行 4 列表格的 DOCX 集合填空题 | 201；单次成功，约 2.6 秒；5,740 tokens | 表头、A/B 两行及全部单元格正确保留为 LaTeX `array`，答案 `{4,6}` 正确。服务端仍添加 `source_table_unresolved`，状态为 `pending_review`。 |
| 含坐标矢量图和一张图片的 PDF 填空题 | 201；第二次结构校验重试成功，约 4.0 秒；两次合计 11,207 tokens | 提取器记录图片与矢量图，模型保留两个缺图占位，没有重造图形；难度为 `unknown`，服务端添加 `source_visual_unresolved`，状态为 `pending_review`。 |

两个暂存记录均可通过 GET 原样读回；隔离题库导入前后数量一致。此次 PDF 首次返回未通过严格结构校验，网关自动重试后成功；证据中保留失败及成功的两次记录。

这证明当前最小样本能够保留规则表格并拦截缺少图像输入的题目，不代表已经支持图片识别。图片像素未提供给模型，表格题也没有因模型输出看似完整而自动发布。DOCX 仍用逻辑页 1 表示整份文档，含图表时会保守地使该文档中的题目待审；PDF 无线表格、复杂合并单元格、扫描页和复杂 Word 公式尚未完成全面验证。
