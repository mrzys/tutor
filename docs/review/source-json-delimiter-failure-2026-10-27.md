# 华师一附中导入失败：公式JSON转义合同未接入正式来源路径

## 实际诊断

用户2026-10-27上传的华中师范大学第一附属中学高三数学无答案PDF，正式导入记录为`import-3c71134f46eac666104a0c52`。本次只读核查正式记录，在SQLite备份副本中做界面回归；未自动发起新模型请求、OCR、题库发布或修改正式导入状态。

- 原OCR已完成，原件和逐页识别材料已保存。
- 原19题来源索引成功，共10个转录批次，8批已保存**16题**草稿。
- 失败批次4为第13、14题；失败批次8为第18题，两份响应均`finish_reason=stop`，没有截断。
- 两份响应的JSON字符串中直接写入单反斜杠的LaTeX分隔符`\(`、`\)`，无法通过严格JSON解析。中文编码完整，不是乱码损坏。
- “模型尝试11次”实际是本轮1次整卷索引加10个转录批次，不是失败后自动重试11轮。模型目录GET和OCR不属于这个聊天请求计数。
- 记录中`questions=[]`表示整卷尚未通过完整性校验、没有交付可审核题，不表示成功批次的草稿丢失。

先前沟通的17题是算术错误，已明确更正为16题；19减去13、14、18三道失败题为16题。

## 根因与修复

正式路径是`source_batches/production.rs` → `model_whole_trial.rs::propose_source_stage_request` → `source_request_stream`。它直接使用`BATCH_PROMPT + ASSET_PLACEMENT_PROMPT`，绕过`model.rs`通用任务里的JSON转义指导。因此修改通用提示词不能约束这条实际来源路径。

新增实际发送的`batch_prompt()`，在原转录和素材合同之间附加：

- 全部文本字段内的公式用`$...$`或`$$...$$`，避免`\(...\)`、`\[...\]`分隔符。
- JSON字符串中的每个LaTeX反斜杠双写，附合法公式JSON示例，明确例子不是原题内容。
- 保留严格JSON解析、原始响应和审计，不做宽松修复、截断拼接或猜补。

同时修正失败卡说明：显示已保存`8/10`批、`16/19`题草稿，待续题号`13、14、18`；请求数显示“索引1次、转录10次”。不将草稿晋级为完整题或可入库题。

## 验证

- 21项正式来源管线HTTP/SSE回归通过，包含新增未转义公式分隔符失败案例。
- 实际HTTP请求体断言包含新合同和合法JSON示例，验证修改接到真正使用的入口。
- 新操作只补失败批次，同操作不重复外呼；成功批次、旧响应字节及旧尝试保持不变。
- 诊断回归4项通过；原严格JSON拒绝测试1项通过；前端136项通过，类型检查及diff检查通过。
- 隔离界面读取真实失败记录，确认展示8/10批、16/19题、待续13/14/18及11次请求分解；控制台无warn/error。
- 回读正式导入记录仍为revision1、failed，整个记录与初始快照一致，8个成功批次未变；新模型/OCR调用均为0。
- 已重新生成正式Windows EXE，用户已保存并退出后覆盖；不自动启动新的导入任务。

## 下一步

用户重新打开新版EXE，在**同一条导入记录**点击“重新解析”。既有OCR、索引和成功8批保留；来源阶段只补剩余两批，再继续原定的完整性校验与后续处理。不必重新上传PDF。由于本轮没有实际追加模型调用，不能声称这份原卷的3道剩余题已经恢复成功。

## 本机证据

`C:\Users\mrzys\AppData\Roaming\fun.mrzys.tutor\maintenance\source-json-contract-20261027-01`

- `initial-record.json`、`protocol.json`、`verification.json`：原始状态与不重复处理核查。
- `ui-diagnostic.json`、`failed-import-progress-fixed.png`：真实记录的隔离界面回归。
- `source-production-tests.txt`、`diagnostic-tests.txt`、`strict-json-tests.txt`、`frontend-tests.txt`、`release-build.txt`。
