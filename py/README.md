# py/ — 本地公式识别旁路进程

这里只有一件东西：`formula_sidecar.py`。它把**已经裁好的**公式小图转成 LaTeX，
供精读稿导出、问 AI、公式索引使用。

它**不找公式、不做版面分析**。找框永远由前端用 PDF 文本层决定（字体族 + 精确坐标）。
原因在 `../docs/formula-local-model.md` 和仓库里的 `formula_model_probe/FINDINGS.md`：
模型在框裁对时 4/4 全对，框裁错时 3/3 全错，而且不是拒绝，是**编造**。

## 1. 环境要求

需要一个装了 `paddleocr` 的 Python（3.9+，实测 3.13 可用）：

```bash
pip install "paddleocr>=3.7" paddlepaddle pillow
# 首次识别时 PaddleOCR 会下载 PP-FormulaNet 权重（plus-S 约 251MB）到 ~/.paddlex/
```

模型是 Apache-2.0，纯本地推理，不需要联网（权重下载那一次除外）。

GPU 不是必须的：plus-S 在 CPU 上约 400ms/条。要更快可以装 `paddlepaddle-gpu`，
本脚本不用改——Paddle 自己会挑设备。

## 2. 插件里怎么开

设置里两项：

| 设置项 | 值 |
|---|---|
| `academicReader.formulaModel.enabled` | `true` |
| `academicReader.formulaModel.pythonPath` | 装了 paddleocr 的那个解释器，如 `D:\python\python3.13\python.exe` |

`pythonPath` 留空会依次试 `python` / `py` / `python3`——但**必须是装了 paddleocr 的那个**，
否则会报 `ModuleNotFoundError: No module named 'paddleocr'`（错误会带在状态栏里）。

打开后，翻到有公式的页面，控制台会看到：

```
[AcademicReader] 公式模型就绪：PP-FormulaNet_plus-S，加载 12000ms
[Viewer] 第 4 页送本地模型识别 6 条公式
[Viewer] 第 4 页本地模型采纳：行间 1 条、行内 4 条
```

采纳前会过一道**字符守恒校验**（见 `../docs/formula-local-model.md` 第 3 节），
被拒的会打成一行日志，例如 `b12: extra-chars cov=0.84 extra=0.42`。

## 3. 单独跑（排查问题用）

```bash
# 协议冒烟：起进程 → 加载模型 → 批量识别 formula_model_probe/out 里的裁图
python py/test_sidecar.py PP-FormulaNet_plus-S --limit 12

# 端到端（含校验）：手工框那 6 个案例
node scratch/formula_sidecar_e2e.js --cases ../formula_model_probe/out_manual/cases.json
```

`test_sidecar.py` 只测协议与吞吐。**判对错**看 e2e 那份表：`ADOPT` 之后接的是模型输出，
`REJECT(...)` 后面的括号是拒绝原因。

## 4. 协议

stdin / stdout，每行一个 JSON。**stdout 只允许出现协议行**——脚本启动第一件事
就是把 `sys.stdout` 换成 stderr，因为 Paddle 建图时会往 stdout 打几十行日志，
那些东西会直接把 `json.loads` 打爆。

请求：

```json
{"id": 1, "cmd": "ping"}
{"id": 2, "cmd": "recognize", "key": "p4_b12", "image_b64": "iVBOR...", "mime": "image/png"}
{"id": 3, "cmd": "shutdown"}
```

事件（不带 `id`）：

```json
{"event": "alive", "pid": 123, "model": "PP-FormulaNet_plus-S"}
{"event": "ready", "loadMs": 12000, "count": 1, "avgMs": 389, "pid": 123}
{"event": "fatal", "error": "...", "trace": "..."}
```

应答：

```json
{"id": 2, "ok": true, "key": "p4_b12", "latex": "\\frac{QK^{tr}}{\\sqrt{C}}", "raw": "...", "ms": 412}
{"id": 2, "ok": false, "key": "p4_b12", "error": "..."}
```

`alive` 是刻意先发的：宿主据此能区分"Python 起来了、模型还在加载"和"根本没起来"。

## 5. 生命周期

- **懒启动**：没开开关、或这一页没有公式，进程不会起来。
- **空闲释放**：默认 10 分钟没请求就退出（`formulaModel.idleTimeoutMs`），下次用重新加载。
- **父进程绑定**：`--parent-pid` 让 sidecar 每秒检查父进程，扩展宿主退出后它自己退，
  不会留孤儿进程占着 900MB 内存。
- **失败冷却**：启动失败后 60 秒内不再重试（否则每翻一页都会卡一次 spawn）。
