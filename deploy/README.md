# 智教部署

生产地址：`https://tutor.mrzys.fun`，服务器 `39.107.240.8`。

- 应用版本：`/opt/tutor-v1/releases/`，`/opt/tutor-v1/current` 指向运行版本。
- 服务：`tutor-v1.service`，普通系统用户 `tutor-v1`，监听 `127.0.0.1:4319`。
- 数据：`/var/lib/tutor-v1/tutor.sqlite`；输出及后续上传数据也保存于此目录。
- 环境：`/etc/tutor-v1.env`（权限 600），模型配置仅在服务器使用。
- 日志：`journalctl -u tutor-v1.service`。
- Nginx：`/etc/nginx/sites-available/tutor.conf`；原配置备份在 `/opt/tutor-v1/backups/`。
- Python：`/opt/tutor-v1/venv/bin/python`；中文字体使用 DroidSansFallbackFull.ttf。

Linux 使用独立的 Node 24 运行时，不替换服务器其他应用使用的 Node。依赖必须在 Linux 安装或构建，不能直接复制 Windows 的 SQLite 原生模块。网络受限时可在相同架构、兼容 glibc 的 Linux/WSL 环境构建后上传，包版本及 integrity 保持锁文件一致。

PDF 环境需要 `python3-venv libcairo2-dev pkg-config fonts-droid-fallback`，在独立 venv 中安装 `requirements-pdf.txt`。部署验证可执行 `node --import tsx deploy/smoke.mjs`：它读取服务器环境配置，在临时数据库副本中验证注册、登录、题库查询、蓝图、成卷及两版 PDF，不写入生产账户或组卷。加 `--ai` 可验证一次真实模型需求整理。全套测试放在独立开发或构建环境运行，避免与生产服务争用小内存主机资源。

第一次部署仅导入题库、教材目录、知识映射、教研标注与题库来源溯源；不携带用户、登录会话、组卷、成卷、调用记录及资源归属。首个注册账户成为管理员。后续发布必须保留生产数据库，不重复覆盖它。

导出题库专用数据库（只写入一个尚不存在的新文件，不改源数据库）：

```powershell
node scripts/export-deployment-bank.mjs SOURCE.sqlite NEW_TARGET.sqlite
```

使用 SQLite 在线 backup 获取一致快照，再将允许的题库表复制到全新数据库。源文件删除过的用户、会话数据也不会以空闲页形式随新库部署。

Nginx 必须覆盖 `X-Forwarded-Proto`；环境设置 `TUTOR_TRUST_PROXY=loopback`，仅信任回环连接提供的协议，确保 HTTPS 同源校验与 Secure Cookie 生效。仅修改指定域名配置，不影响其他站点。

更新流程：备份生产库和配置，将完整代码与 `dist/` 上传至新的版本目录；保留题库 manifest 引用的原始题源（含 `docs/validation/raw/`）及 `materials/` 素材。在 Linux 安装依赖，测试通过后切换 `current` 并重启。配置修改先执行 `nginx -t`，通过后 reload。回滚时恢复旧配置和版本链接，保留数据库备份。
