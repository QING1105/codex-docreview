# 在 Codex 中安装 Doc Review

使用 Codex 自带的 skill-installer，从 `QING1105/codex-docreview` 安装 `skills/doc-review`。

- 安装范围为该技能目录，按 skill-installer 的用户技能目录约定落盘。
- 已存在同名技能时，先检查版本和本地修改，再按用户的更新要求处理。
- 完成后告诉用户：下一轮输入 `$doc-review 打开文档批注页`。
- 首次使用由技能内的 `scripts/run.ps1` 自动准备运行环境。文档与队列继续保存在原有数据目录。
- 审阅绑定触发技能的当前聊天，保留宿主聊天环境变量。
