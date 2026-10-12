# Testing

## 小型测试（不下载模型和完整词库）

```powershell
$env:BESTDICT_PYTHON = 'python'
npm.cmd run test:unit
```

使用 Python 3.12 标准库、临时 JSONL fixture 与 SQLite，验证语言过滤、
Unicode 规范化、日文读音索引、词库状态、错误资源、HY 翻译方向，
以及 Argos 双向模型下载、校验失败、原子安装与重试。
CI 只运行这组测试与 TypeScript / Vite 构建，不自动下载第三方数据。

## 常规客户端

按照 README 准备运行时和内置资源后：

```powershell
npm.cmd test
npm.cmd run build
npm.cmd run test:desktop
```

Electron 测试使用临时 userData、独立快捷键 `Ctrl+Alt+Shift+F11`。
默认启动不加载任何翻译模型；验证单词、词组、未开启翻译的 UI 引导和 IPC 拒绝，
以及禁止选择尚未安装的引擎。常规 `npm test` 跳过需要真实权重的推理测试。
同时验证中文默认、英文切换与保存、原生托盘菜单语言、宣传文案移除、
最小化后托盘对象保留、单击 / 双击恢复以及托盘设置菜单。
托盘事件由独立测试进程触发；Windows 通知弹窗和系统任务栏设置不自动点击。
测试不会修改真实配置或开机启动，也不会关闭用户正在运行的旧版。

## 完整资源验证（开发者显式下载）

可选资源不进入发行包。以下脚本仅在项目 `.cache` 中下载公开数据供验证：

```powershell
.venv\Scripts\python.exe scripts\research_dictionary.py
.venv\Scripts\python.exe scripts\research_hy.py
.venv\Scripts\python.exe scripts\research_argos.py
.venv\Scripts\python.exe scripts\prepare_validation.py
$env:BESTDICT_REAL_ASSETS = '1'
npm.cmd test
Remove-Item Env:BESTDICT_REAL_ASSETS
npm.cmd run test:multilingual
node scripts/import-smoke.mjs
```

会验证四个真实词库的中文释义、切换、Argos 中英双向与 HY-MT1.5 CPU 推理、五种源语言翻译与缓存。
桌面测试还验证已有模型不会自动启用、手动开启两种引擎、关闭后阻止翻译并保留文件。
常规桌面测试验证复制两套官方直链、复制不触发下载、非法资源不能改写剪贴板与导入取消。
`import-smoke.mjs` 使用真实中英模型包验证双文件选择、本地导入、保存启用和实际翻译。
`prepare_validation.py` 校验官方模型 SHA-256，在 `.cache/validation-library` 建立词库。
这是测试目录，不是用户的安装目录。

## 打包后验证

```powershell
npm.cmd run package
$env:BESTDICT_TEST_EXE = "$PWD\release\win-unpacked\BestDict.exe"
npm.cmd run test:desktop
npm.cmd run test:multilingual
Remove-Item Env:BESTDICT_TEST_EXE
```

截图和 JSON 结果位于 `test-results`。README 截图保存在 `docs/assets`，
更新时使用实际客户端截图，并确认其中没有个人信息。
打包流程扫描 `win-unpacked/resources/assets`，确认没有 `models`、`.argosmodel`、`.gguf` 或 `model.bin`。

自启动的真实登录流程与安装器交互应在独立 Windows 虚拟机中验证。
目前自动测试验证快捷键注册、隐藏与聚焦、打包后的资源访问，不模拟系统重启。

### 自动匹配回归

准备 `.cache/validation-library` 中的四种真实词库后运行 `node scripts/auto-dictionary-smoke.mjs`。可设置 `BESTDICT_TEST_EXE` 指向打包后的程序。覆盖默认英语下查询 perro、日语、韩语、同形词法语候选、关闭自动匹配、主界面下拉切换、设置落盘和页面重载；使用独立测试配置，不修改用户设置。
