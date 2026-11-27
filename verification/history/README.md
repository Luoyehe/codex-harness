# 历史验证记录

此前各版的源码、测试结果、失败复盘、逐项证据及其原校验值可从固定提交取回。[v2.5.0 增量修复时的完整记录](https://github.com/Luoyehe/codex-harness/tree/b2f5a1f798e9fb26ba40eb79d8bb63ab93ca8052/verification)

在仓库根目录运行以下命令，可以单独取回 v2.4.0 的公开整理归档并在本地验证。Git 会从历史对象取出文件，不切换当前工作区。

```sh
mkdir -p .work/prior-evidence
git show b2f5a1f798e9fb26ba40eb79d8bb63ab93ca8052:verification/history/through-v2.4.0.zip > .work/prior-evidence/through-v2.4.0.zip
git show b2f5a1f798e9fb26ba40eb79d8bb63ab93ca8052:verification/history/through-v2.4.0.json > .work/prior-evidence/through-v2.4.0.json
python3 scripts/historical-evidence.py --archive .work/prior-evidence/through-v2.4.0.zip --verify
```
