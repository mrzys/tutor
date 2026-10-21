# 学生管理与作答日期界面回归（2026-10-21）

本次仅调整学生页布局、来源说明和作答日期交互，不改变学生答卷持久化、批改条件或模型请求边界。所有数据均为临时昵称和隔离目录中的模拟回归案例，不代表真实教师使用或真实手写批改质量。

## 调整

- 学生工作区最大宽度 1540px，左侧可读学生名单，右侧集中显示学生资料和练习；手机使用横向学生名单。
- 分开设计无学生、无答卷状态，提供直接的新增／上传入口；记录行集中显示名称、日期、来源和状态。
- 来源入口改为“已组好的试卷／上传其他练习”，底层仍为 `paper / external`。前者复用成卷冻结内容，后者须提供完整原题，所有记录均在本机保存。
- 中文日期组件支持年月切换、今天、清除、方向键、Enter、Escape及外点关闭；未选择日期仍保存为 null，不将日期字符串当作 UTC 时间转换。

## 构建与自动验证

- `npm run build` 通过：Solid 类型检查、Vite 生产构建和 Rust desktop 特性检查。
- `npm --prefix desktop run test:blueprint`：17 项通过，0 失败。
- 未提供可用 Browser 插件，按前端验证 skill 使用 Playwright。浏览器通过 IPC 桥连接实际 Rust debug driver；测试原件及 SQLite 由真实 Rust 创建和读取，没有以 localStorage 或伪造业务响应代替持久化。
- 初轮 8 组目标浏览器回归通过，`errors=[]`：空库、无答卷、记录、来源切换、日期选择／清除、Escape、外点关闭、390px 视口日历定位；真实 Rust 保存 `completedOn=2026-10-15`，另一份未选择日期保存 null。未发起批改或外部模型／OCR 请求。
- 初轮证据：`C:/Users/mrzys/AppData/Local/Temp/tutor-student-layout-8kZLrT/layout-date-result.json`、`trace.json` 及同目录截图。已实际查看 2048px 学生页、1440px 和 390px 日历截图；发现计数被全局样式覆盖后，提高对应规则的选择器权重。
- 最终定向 9 组全部通过，`errors=[]`，补齐 3440px、已有答卷列表以及计数位置验证。证据为 `C:/Users/mrzys/AppData/Local/Temp/tutor-student-layout-QPZCJM/layout-date-result.json`、`trace.json` 和同目录截图；各尺寸计数与标题间距均为 12px。主代理实际查看最终同版 `tutor-student-layout-W86MNV` 中 3440px 无答卷、1440px 与390px已有记录列表；内容宽度受限、记录数量紧随标题，移动列表无横向溢出。
- 日期组件另以真实 `ui.Modal` 验证原生 popover 和禁用该 API 的 fallback，两个模式均通过，无控制台错误。覆盖键盘焦点、Escape、外点保留输入焦点、年月浏览不写入、闰年／月末、日期目标44px和弹窗边界外命中。固定同一时刻在上海和洛杉矶验证“今天”分别为当地日期，不发生 UTC 偏移；证据在 `C:/Users/mrzys/AppData/Local/Temp/tutor-date-field-qa/result.json`、`date-field.mjs` 及同目录截图。

原生 Tauri 窗口的操作系统输入与 WebView2 专属行为不在浏览器回归证据中；发布构建另行记录。

## 同轮追加：侧栏学生标签与空输入光标

- 侧栏学生标签改为细边框胶囊，姓名 13px，去重复人像；长名只截姓名，`+N`、题量及日期保持可见。完整名单保留 tooltip 与可访问名称。真实组件模拟布局在 1440／390px 回归通过，证据在 `C:/Users/mrzys/AppData/Local/Temp/tutor-history-student-label-qa/result.json` 及截图，主代理实际查看390px截图。
- 修复前通过隔离 Rust 的真实组卷页面复现：空编辑器虽然 focused、选区位于编辑器内，但 Range 几何为0，连续7帧没有光标变化；已有正文和学生标签后的光标则呈1×19px原生闪烁。证据 `C:/Users/mrzys/AppData/Local/Temp/tutor-student-layout-9fOoiv/caret-result.json`、`caret-frame-diff.json`。
- 用实际内部文本锚点替代纯 CSS 生成的零宽字符，保留 inline 编辑器；正文投影、位置映射及复制／剪切均排除内部标记。空态聚焦和清空后选到真实文本位置，不增加模拟光标。
- 首轮修复回归 `C:/Users/mrzys/AppData/Local/Temp/tutor-student-layout-2Xm83w/caret-frame-diff.json`：占位文字、空白、已有正文、鼠标点学生标签之后，均在7帧中呈两种循环帧，变化恰为1×19px的原生光标。截图显式使用 `caret:'initial'`，避免 Playwright 默认隐藏 caret 导致误判。
- 多行全选删除另复现 Chromium 只留下内部锚点中的单独 LF：基于删除意图和精确残留形状恢复空态，不对一般需求正文修剪换行。保留失败记录 `tutor-student-layout-Z9Cx6c`、`MMZAD5` 和定位证据 `XHXslc`；无几何的容器 Range 也可能实际绘制原生光标，因此不把所有 Range height=0 都判作故障。
- 最终交互9组通过，`errors=[]`：空态输入、清空／撤销、换行后再次清空、Home／ArrowLeft、`@` 的 Tab／Enter、删除引用再撤销、复制及重新聚焦。实际 Rust `intake_prepare` 的 rule 请求中 `message`／`teacherRequest` 均无内部标记、无学生姓名，学生关联仍独立保存。证据 `C:/Users/mrzys/AppData/Local/Temp/tutor-student-layout-S7SO4d/caret-interaction-result.json` 与 `trace.json`。
- 追加修改后，学生页／日期目标9组在 `tutor-student-layout-oMqCB3` 重新通过；实际历史列表标签在 `tutor-student-layout-XCk1ID` 验证 1440／390px、长名和多学生人数展示。
- 最终源码帧对照在 `tutor-student-layout-SGdkiY/caret-frame-diff.json` 重跑，四点位仍为1×19px原生闪烁；主代理实际查看空态闪烁帧截图。最终多行末尾也通过帧对照，证据同 `S7SO4d`。多学生样本为明确标记的隔离历史兼容记录，当前组卷仍只选一名学生。

## 最终可执行文件

最后一次 `npm run desktop:build` 在全部上述源码冻结后成功，执行 `tauri build --no-bundle`。未制作安装包，未启动发布 EXE 或修改真实用户数据库。

- 文件：`desktop/src-tauri/target/release/tutor-desktop-0.1.32.exe`。
- Windows 文件版本／产品版本：`0.1.32`。
- 大小：`39,778,304` 字节。
- SHA-256：`745B62F9140A6B5074FA083AF41F2B5A0A0586C1A008E11A2B73598405AB5501`。
- 标准 `tutor-desktop.exe` 与版本文件哈希一致；旧 `0.1.31` 文件保留。

追加交互修改期间的较早构建未作为交付版本，最终文件包含全部日期、学生标签及空输入修复。Vite 分块大小、Cargo同名输出及Windows链接信息仍为构建提示，最终退出码为0。
