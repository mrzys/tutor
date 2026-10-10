# Tutor v1

当前完成 S3-01、S3-02：从已归档集合材料读取经过核查的独立题目，在本地确认需求、调整蓝图、真实选题并保存可重新打开的草稿。局部调整和两版输出进入 S3-03、S3-04。

需要 Node.js 24 或更新版本，无须数据库或 API 密钥。在仓库根目录执行：

```powershell
npm ci
npm run build
npm start
```

打开 <http://127.0.0.1:4318>。开发模式使用 `npm run dev`，打开 <http://127.0.0.1:5173>；开发模式同时启动 API，不要与 `npm start` 同时运行。两种模式使用相同的 `.tutor/drafts/` 本地草稿目录，该目录不提交 Git；备份时需单独保留。

界面采用可见的集合专项预设，无模型调用。默认从 18 道已就绪题中按具体任务、来源、允许解法与重复关系选取 10 题，6×8+2×10+14+18=100 分。候选不足会保留空位；难度没有独立估计时显示未知。需求和蓝图可编辑；草稿内换题、锁定和最终输出尚未提供。

题库命令与工程检查：

```powershell
npm run bank:list
npm run bank:get -- tutor-set-001 --student
npm run bank:get -- tutor-set-041
npm run bank:get -- tutor-set-050
npm run bank:check
npm test
```

`list` 显示全部 50 个来源单元及实际处理状态：首批 18 题就绪，32 题待整理。先查询返回的 `contentVersion`，再用 `--version content-…` 读取指定内容；还可用 `--teacher-version teacher-…` 固定教师资料版本。版本不匹配会报错，不会偷偷改读最新版本。`--student` 仅返回学生题面及身份/版本，不返回教师答案或核查笔记。

数据与核查说明见 [S3-01 交付记录](docs/validation/s3-01-question-data.md)。组卷运行、实际选题及标杆差异见 [S3-02 交付记录](docs/validation/s3-02-assembly-draft.md)。后续任务见 [MVP 开发任务](docs/tasks/mvp-implementation.md)。
