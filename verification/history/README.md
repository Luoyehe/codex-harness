# 历史审计证据

> 本归档校验的是公开整理后的副本。部分原始运行记录含私人信息，已移除相关字段。原版的签名、审核结论和发布授权仅适用于当时核验的字节。

这个归档保存了 v2.4.0 隐私整理版中 874 份已结案的 JSON 记录。索引列出原路径、大小、SHA-256 和 Git 对象标识。另外 235 份记录保存在原路径，包括当前版本的验证、发布授权、近期审阅及仓库 Markdown 直接链接的历史证据。

在仓库根目录用 Python 3.11 或更新版本运行下列命令，即可离线核验或查看历史证据。

```sh
python3 scripts/historical-evidence.py --verify
python3 scripts/historical-evidence.py --list
python3 scripts/historical-evidence.py --show verification/audit-evidence/目录名/记录名.json
python3 scripts/historical-evidence.py --restore .work/restored-audit-evidence
```

还原目录须为新目录。还原后的文件保留原有相对路径，可与整理后的同版本 Git 树逐字节对照。ZIP 和同名 JSON 索引可作为发布附件一起分发。
