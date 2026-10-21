# 外部练习原试卷选填与上传弹窗（2026-10-21）

依据用户明确补充要求：外部练习不强制上传原试卷，也不要求勾选“答卷包含完整题目”。这是对 ADR-0007 同日早期限制的更新，已同步协作约定及使用说明。

## 行为与边界

- 选择学生、填写练习名称、添加答卷后可直接保存或显式发起后台批改；原试卷为选填。
- 无独立原题时保存为 `answer_only`，不将此模式当作题干完整声明。模型须从实际答卷材料定位题干和作答；缺少必要题干、图表或可靠作答证据时保留无法判断，不根据练习名称编造题目，也不把未识别当作错误。
- 提供原试卷时继续使用 `separate_materials`；历史 `answer_contains_questions` 和冻结成卷关联兼容。
- 原件、哈希及所有权校验，后台运行／取消／重试、原模型与教师修正分离均沿用现有边界。个人记录不加入题库。

## 界面

上传弹窗收至最大860px，学生与来源选择并排，窄屏改为单列。学生答卷为主要上传区，原试卷默认折叠为选填补充项；日期和备注继续可选。底部固定保存入口，并给出尚缺的必填项，不以不可用按钮代替解释。
弹窗切换来源保持外框高度稳定，文件支持预览和移除；隐私说明保留，明确发起批改会将材料发送至当前配置服务。

## 验证原则

回归使用独立临时昵称、真实 Rust IPC／SQLite 和仓库外模拟材料。模型及 PaddleOCR 由本机模拟服务提供，不访问实际用户数据或真实供应商。模拟用例只证明请求、校验和持久化行为，不证明真实手写或数学批改质量。

## 已完成验证

- `cargo test --manifest-path desktop/src-tauri/Cargo.toml --no-default-features --lib student_work`：12 项通过。
- 同配置全量 Rust 回归：251 项通过，0 失败，1 项原有 Office 集成测试跳过。
- `npm --prefix desktop run test:blueprint`：17 项通过。
- `npm run build`：Solid 类型检查、Vite 生产构建与 Rust desktop 特性检查通过。
- 新版真实 driver 构建后运行的独立链路回归9组通过：无配置仅保存、有实际题干可判、缺题干高置信仍无法判断、缺完整性字段保守处理、只有解／答案不冒充题干、空模型结果不硬失败、选填原题、旧模式、冻结成卷、重开保留日期和文件。证据 `C:/Users/mrzys/AppData/Local/Temp/tutor-student-work-1HJ6HY/optional-source-rust-result.json` 和同目录 `trace.json`。
- 浏览器目标6组通过，无控制台错误：无需原题或勾选即可保存，取消后保留文件、名称、日期、备注及原学生归属，真实持久化 `answer_only`，可选原题保存为 `separate_materials`，旧 `paper` 保持不变。证据 `C:/Users/mrzys/AppData/Local/Temp/tutor-student-work-sZdizi/optional-source-ui-result.json`、`trace.json` 及同目录截图。
- 主代理实际查看1440px和390px上传界面及390px展开原题补充区。桌面与手机无横向溢出，操作固定在底部；切换来源在入场动画完成后高度一致。
- 实际 driver SHA-256：`62EB92FD6CD55830FC6596DD4C2C2E1856E4EA2813E8F920C4EA1A90A8A280FA`。浏览器插件未提供，按前端验证 skill 使用临时 Playwright 桥接真实 Rust；未用假 localStorage 代替保存。

初次浏览器脚本在入场动画中比较高度，以及缩至手机后未收起原桌面侧栏，分别导致断言和点击拦截；修正脚本为等待动画完成并正常收起侧栏后重跑。失败证据保留，不作为产品通过证据。测试未改变真实个人库、共享题库或已有成卷。

## EXE 交付

`npm run desktop:build` 成功执行 `tauri build --no-bundle`，只生成可执行文件，不制作安装包。未启动发布程序访问用户数据库。

- 文件：`desktop/src-tauri/target/release/tutor-desktop-0.1.33.exe`。
- Windows文件与产品版本：`0.1.33`。
- 大小：`39,816,192` 字节。
- SHA-256：`21B55FCBF2837043433F6000C0EC38D655940D7FE7AF88DBEADAD028564FEEB9`。
- 标准 `tutor-desktop.exe` 哈希一致，旧版本保留。构建产物沿用 Git 忽略规则，不提交到源码。

Vite分块大小、Cargo同名产物及Windows链接信息仍是现有构建提示，最终退出码为0。原生窗口输入和真实手写质量不在浏览器模拟证据中。
