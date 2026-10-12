# 试卷生成进展 · 2026-10-12

## 交互

确认蓝图后，在蓝图上方显示进度卡片：查找候选 → AI 比较 → 去重组合 → 保存草稿。显示真实已用时间及每批题型、题位数、等待/比较中/完成状态。不估算百分比或剩余时间。规则选题明确跳过 AI 比较。停止和失败保留已接收的进度，提供重试/规则选题。

## 实现

现有 POST /api/drafts 通过 Accept: application/x-ndjson 启用进度流，原 JSON 调用兼容。批次仅在模型结果验证通过后计为完成。所有批次通过才执行全局组合；草稿持久化成功才返回终态 draftId。随后 GET 已保存草稿，使用线上现有 JSON gzip，避免发送庞大的未压缩流终态。断开连接取消未完成模型调用；保存阶段断线的结果需从历史记录确认。

## 验证

- 54 项针对性测试通过：真实 HTTP 流在模型完成前可读、并行批次更新、失败/保存错误、取消、身份隔离、全局去重、可选覆盖复核、拆分 UTF-8 解码。
- npm run build 通过（包括 typecheck）。
- CUA 渲染实际 GenerationProgress 组件，桌面及 390×844 手机验证；手机 document.scrollWidth=clientWidth=390。停止/重试状态正确，控制台无 error。
- 视觉验证使用隔离组件示例；没有宣称完成线上登录后的真实模型组卷测试。

## 发布

- 仅 14 个增量文件，gzip 包 363,929 字节；上传限制为 base64 流 64 KiB/s。
- 包 SHA256: fcc8358d992619df3d5d2db07d584473e697aa27cea866653fceed8391345f20。
- 备份 /opt/tutor-v1/backups/20261012-generation-progress/before.tar.gz；先安装 assets，再替换后端/index，重启 tutor-v1 一次。
- 服务 active；线上 index 与本地 build 一致，静态资源/前端路径正常，匿名业务 API 仍返回 401。
- 未改动生产数据库、账户、组卷记录、Nginx 或模型配置。
