# 桌面导入初审与导航回归（2026-10-20）

本次为隔离数据及模拟 provider 的开发回归，不代表真实教师采用或模型审核准确率评估。

## 已验证

- 真实 Rust 持久化及 Playwright：未完成审核、题面存在未保存修改时可返回组卷；Composer 原 DOM、正文及学生引用保留；返回导入记录再打开可恢复本窗口缓冲。
- 审核统一展示原题及原卷实际答案解析，不显示学生／教师版 Tab；LaTeX 正常渲染。
- 实际 2008 北京第 8 题只读检查：四个图选项在题干末尾，展示投影保留一张正方体题图并将四图排成两列；用户库哈希未变。结构含糊时不猜测拆分。
- 模拟短分式四列、图选项两列、长选项四行；图片加载、字体及尺寸变化重新测量。PDF 输出仍沿用原版本布局。
- 2048、1440、390 宽度对照弹窗分别约 2000×1218、1392×968、362×828；切换原图／识别文字／并排保持高度，切页、缩放、缺图提示及 Escape 正常，控制台无错误。
- 实际 Rust＋本机模拟 HTTP：模型高置信且无疑点题可入库，中置信疑点、缺图题保持待处理。模型意见不勾选人工清单、不写人工 approve、不自动入库；一次显式确认仅发布符合条件的子集。
- 模拟 PDF 普通上传完整执行 OCR → 模型结构化 → 模型初审，后台在初审结束前不暴露已完成状态。读取历史与导航不外呼。
- 源页及题图实际组装进支持视觉的模型请求；修改题面使旧意见失效，客户端不能伪造意见。发布重新验证来源、OCR、题面及审计哈希。

## 验证与产物

- 前端构建成功；12 项前端规则回归通过。
- 最新完整 Rust 回归：235 通过，0 失败，1 项依赖本机 Office 的集成测试忽略。
- `tauri build --no-bundle` 成功，仅生成 EXE，未制作安装包。
- 版本：0.1.28；`tutor-desktop-0.1.28.exe`，39,220,224 字节。
- SHA256：`BF8A5374892490A8D92F94987FE03391BE5D46AF3E8564CD2A67E0FA41A38AB4`。

外部临时证据（不纳入仓库）：

- `C:/Users/mrzys/AppData/Local/Temp/tutor-review-ui-bPlXnH/navigation-result.json`
- `C:/Users/mrzys/AppData/Local/Temp/tutor-review-ui-xHe6Ap/model-review-ui-result.json`
- `C:/Users/mrzys/AppData/Local/Temp/tutor-review-ui-Y4LJWE/upload-review-result.json`
- `C:/Users/mrzys/AppData/Local/Temp/tutor-adaptive-options-vYMxg5/result.json`

旧记录不会因打开页面自动获得模型意见，需明确点击“模型初审”。置信档是模型自评；本回归只证明路由、展示和入库边界，不证明真实试卷审核准确率。未保存编辑仅保留在当前窗口，退出应用前仍应保存。

## 0.1.29：整理与检查合并

用户澄清不需要独立模型初审流程。本节取代上文的“上传后再调用模型检查”与常驻按钮说明。

- 普通新上传一次 `question_import` 模型响应同时返回题目、标注和逐题 `review`，不再在解析后逐题额外请求；原有格式／素材错误重试边界不变。
- 完成后直接展示检查意见与模型自评置信档。无常驻“模型初审”按钮；仅题面修改、检查失败或旧记录缺意见时出现“重新检查”。
- 初次响应缺失或无效意见不丢弃已解析题目，记录具体原因且不静默追加模型请求；不因此放行题目。
- 同次整理意见绑定实际 provider 响应、原题号、页码、最终题面及原卷哈希；与显式重检审计区分，不能互换。意见不是独立核验，正常题仍由用户明确统一确认入库。
- 请求审计已存在且字节相同时复用；冲突不覆盖，模拟个人记录未提交后的重入不会把有效意见误降为失败。
- 真实 Rust、隔离 SQLite、本机模拟 OCR／LLM 与 Playwright 验证：新 PDF 正常仅一次 LLM 调用；直接显示可入库意见；修改后重检；旧记录只读无外呼；缺失意见不额外调用；显式统一入库；离开保留编辑；390px 无横向溢出。控制台错误为零。
- 最新完整 `npm test`：12 项前端规则测试通过，Rust 237 通过、0 失败、1 Office 依赖测试忽略。桌面前端构建通过。
- `tauri build --no-bundle` 成功，保留版本化 `tutor-desktop-0.1.29.exe`，39,257,600 字节；SHA256 为 `2C956754281B6FEB59DBF38B5E82DEBBD640DA73773169C1747AFD5026182A85`。仅构建 EXE，未制作安装包。

本轮证据位于 `C:/Users/mrzys/AppData/Local/Temp/tutor-review-ui-ahG1Co/integrated-ui-result.json`，
完整测试日志位于 `C:/Users/mrzys/AppData/Local/Temp/tutor-import-integrated-final-test.log`。
这些都是模拟回归，不能证明真实试卷准确率或真实教师使用效果。
