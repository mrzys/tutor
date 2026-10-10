# Tutor v1

当前实现 S3-01：从已归档集合材料读取经过核查的独立题目。组卷界面、自动选题和成卷输出进入后续 S3-02～S3-04。

需要 Node.js 24 或更新版本，无第三方运行依赖，无须数据库或 API 密钥。在仓库根目录执行：

```powershell
npm run bank:list
npm run bank:get -- tutor-set-001 --student
npm run bank:get -- tutor-set-041
npm run bank:get -- tutor-set-050
npm run bank:check
npm test
```

`list` 显示全部 50 个来源单元及实际处理状态：首批 18 题就绪，32 题待整理。先查询返回的 `contentVersion`，再用 `--version content-…` 读取指定内容；还可用 `--teacher-version teacher-…` 固定教师资料版本。版本不匹配会报错，不会偷偷改读最新版本。`--student` 仅返回学生题面及身份/版本，不返回教师答案或核查笔记。

数据与核查说明见 [S3-01 交付记录](docs/validation/s3-01-question-data.md)。后续任务见 [MVP 开发任务](docs/tasks/mvp-implementation.md)。
