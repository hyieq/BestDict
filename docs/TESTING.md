# Testing

## macOS Apple Silicon 预览包

`.github/workflows/macos.yml` 在 Apple Silicon `macos-15` 上运行，可手动触发，
也会在 main / codex/macos-* 分支代码推送和 PR 时运行。流程准备独立的
Python 3.12.10、ctranslate2、sentencepiece、sherpa-onnx 和固定版本 llama.cpp，
执行资源测试并生成临时签名的 DMG / ZIP；不创建 tag，也不发布 GitHub Release。

在 Mac 上本地复现（需要 Node 22、Python 3.12、uv）：

```sh
npm ci
python3 scripts/setup_assets.py
python3 scripts/setup_hy_runtime.py
python3 scripts/copy_licenses.py
npm test
npm run package
python3 scripts/verify_macos_bundle.py release/mac-arm64/BestDict.app
BESTDICT_TEST_EXE="$PWD/release/mac-arm64/BestDict.app/Contents/MacOS/BestDict" npm run test:desktop
```

CI 将 `.app` 复制到包含空格的独立目录后，校验签名、包内符号链接、模型权重排除、
Python 原生模块导入、77 万词条查询及 llama-server 启动；资源测试也验证系统语音生成 WAV，
不播放声音。随后执行打包后桌面、
查询模式、AI 样式/菜单、发音缓存和迷你模式交互测试。测试使用 BESTDICT_TEST 隔离配置。
macOS CI 的虚拟声卡播放速度可能慢于真实时间，发音测试最多等待 30 秒，
仍验证真实 WAV 解码、自然播放结束、取消及缓存，不模拟播放结束事件。
自动测试不下载真实翻译/语音模型，不能代替真实推理、Gatekeeper 下载隔离、
登录自启动、系统快捷键权限和硬件上的体验验收。Mac 不运行 Windows 截图测试。

成功时上传安装包、SHA256SUMS.txt，失败时仍上传已有测试证据。构建产物保留 30 天。
当前仅为 Apple Silicon 临时签名测试包；正式公开分发前需接入 Developer ID 签名和公证。

## 截图翻译

准备运行时：`.venv/Scripts/python.exe scripts/setup_ocr_runtime.py`。构建后运行
`npm.cmd run test:capture`，独立快捷键为 Ctrl+Alt+Shift+F8。
使用独立配置和模型目录验证缺模型引导、框选、真实 PP-OCRv6 中英文识别、复制、
原文编辑、自动/手动翻译、置顶、进入主界面、Escape 恢复与模型卸载。
翻译推理在此交互测试中替换，OCR 不替换。无物理显示器的 CI/服务会话会以实际
Electron 窗口截图作为屏幕输入，报告中的 nativeCapture 标明是否测试真实桌面捕获。
结果存放在 test-results/capture，仅保存合成测试内容。物理多屏、混合 DPI、
显示器断开及 Windows 桌面合成需要可见桌面验收；测试截图不可用作实际 AI 翻译宣传图。
`node --test tests/capture.test.cjs tests/ocr.test.cjs` 验证像素映射、非法选区及下载校验/取消。
`python -m unittest discover -s tests -p test_ocr_layout.py` 验证分栏及段落合并。
设置 `BESTDICT_REAL_CAPTURE=1` 后，截图交互测试会额外使用
`.cache/validation-library/hy-mt2` 中已有的真实 HY 模型验证翻译并保存截图。

## 迷你模式

构建后运行 `npm.cmd run test:mini`。使用隔离配置验证真实离线查询、复制释义、
主窗口与迷你窗共享查询、尺寸恢复、置顶、失焦隐藏、Escape、快捷键注册和冲突回退，
以及中英文、深浅色与 150% 缩放。通过注册回调测试窗口切换，不模拟系统键盘。
截图保存在 `test-results/mini`。迷你模式的独立测试快捷键为 Ctrl+Alt+Shift+F9。
发音使用实际服务、磁盘缓存和音频播放，仅替换模型推理为静音 WAV；
验证重复播放只调用一次推理。

## 发音缓存

`node --test tests/speech-cache.test.cjs` 验证重复播放和重启复用、发音参数及模型隔离、
容量与条目数上限、LRU 淘汰、损坏缓存重建、磁盘失败回退，以及取消和清理期间的并发写入。
测试使用临时缓存目录和 WAV fixture，避免访问真实用户缓存。
`npm.cmd run test:speech` 使用真实 IPC、缓存服务和音频播放，替换推理响应为静音 WAV；
验证重播不调用推理、设置页显示占用与清理、清理保留语音模型和随后重新生成。
截图保存在 `test-results/speech-cache-settings.png`。

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

## 毛玻璃界面

构建后运行 `npm.cmd run test:glass`，验证浅深色与原生主题同步、透明窗口背景、
中英文界面、780×580 小窗口、150% 页面缩放，以及多行输入自动增高。
同时在隔离进程中模拟系统减少透明效果，验证不透明回退；检查减少动画设置。
截图与结果写入 `test-results/glass`。系统 Acrylic 的实际观感随桌面背景和 Windows 设置变化，
页面截图主要用于检查前端布局；发布前还需目视检查桌面合成、窗口移动和缩放。

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
`import-smoke.mjs` 使用真实中英模型包验证双文件选择、本地导入、首次安装默认启用和实际翻译。
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

### 基础翻译与 AI 分离

`npm run test:translation-ui` 使用隔离配置和模拟引擎响应，验证 HY 仅由按钮调用、Argos 与 HY 共存、未收录短词组保持查词、词库选择不改变翻译方向、AI 不覆盖基础结果、输入变化取消旧 AI 请求，以及设置页默认折叠。真实词库、IPC 和界面使用实际客户端。
`npm test` 同时覆盖句子判断、中英方向和不支持语言的拒绝；真实模型推理仍由完整资源测试覆盖。

### 自动匹配回归

准备 `.cache/validation-library` 中的四种真实词库后运行 `node scripts/auto-dictionary-smoke.mjs`。可设置 `BESTDICT_TEST_EXE` 指向打包后的程序。覆盖默认英语下查询 perro、日语、韩语、同形词法语候选、关闭自动匹配、主界面下拉切换、设置落盘和页面重载；使用独立测试配置，不修改用户设置。
