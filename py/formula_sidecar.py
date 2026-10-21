"""公式识别旁路进程（sidecar）——给 VS Code 扩展提供本地公式转 LaTeX 能力。

## 它解决的是哪一半问题

`formula_model_probe/FINDINGS.md` 的实测结论：识别器在**框裁对**的时候 4/4 全对，
框裁错的时候 3/3 全错。也就是说本地模型不该被用来"找公式"，只该被用来
"把已经裁好的那一小块转成 LaTeX"。找框仍然由宿主/前端用 PDF 文本层决定
（字体族 + 几何位置，确定性、零延迟），这里只吃裁好的图。

## 为什么是独立进程而不是扩展内推理

扩展宿主是 Node，没有 Python 运行时；而 PP-FormulaNet 只有 Paddle 权重。
所以用 stdio 上的逐行 JSON 做 RPC：没有端口占用、没有防火墙弹窗、
父进程一死子进程跟着退出（见 --parent-pid）。

## 协议（stdin/stdout，每行一个 JSON）

请求：
    {"id": 1, "cmd": "ping"}
    {"id": 2, "cmd": "recognize", "key": "p3_12", "image_b64": "iVBOR...", "mime": "image/png"}
    {"id": 3, "cmd": "stats"}
    {"id": 4, "cmd": "shutdown"}

响应（ok 同为请求 id；事件不带 id）：
    {"event": "ready", "model": "PP-FormulaNet_plus-L", "loadMs": 5200, "pid": 123}
    {"id": 2, "ok": true, "key": "p3_12", "latex": "...", "raw": "...", "ms": 810}
    {"id": 2, "ok": false, "key": "p3_12", "error": "..."}

**stdout 只允许出现协议行**。Paddle 家族会在 import / 建图阶段往 stdout 打
一大堆 "Creating model:" / "WARNING:"，那些会直接把 json.loads 打爆，
所以启动第一件事就是把 sys.stdout 换成 stderr，真正的协议通道单独留在 _PROTO。
"""

import base64
import io
import json
import os
import re
import sys
import threading
import time
import traceback

# ---------------------------------------------------------------------------
# 协议通道必须在 import 任何第三方库之前抢下来
# ---------------------------------------------------------------------------
_PROTO = sys.stdout
sys.stdout = sys.stderr


def _emit(obj):
    """往协议通道写一行 JSON 并立刻 flush（父进程按行读，缓冲会卡死握手）。"""
    try:
        _PROTO.write(json.dumps(obj, ensure_ascii=False) + "\n")
        _PROTO.flush()
    except Exception:  # noqa: BLE001 - 父进程已退出时写管道会报错，直接忽略
        pass


def _log(msg):
    sys.stderr.write(str(msg) + "\n")
    sys.stderr.flush()


# ---------------------------------------------------------------------------
# LaTeX 后处理
# ---------------------------------------------------------------------------
_CMD_RE = re.compile(r"\\[A-Za-z]+")


def collapse_spaces(latex: str) -> str:
    """`A t t I D` -> `AttID`，但不碰 `\\in R` / `\\times C`。

    UniMERNet 系（PP-FormulaNet 就是这一族）把每个字母当成独立 token 输出，
    解码时会插空格。直接送去 KaTeX 会渲染成 "A t t I D"（实测）。
    只在**纯字母数字之间**删空格，命令名后面的空格是语法的一部分，必须留着。
    """
    parts, last = [], 0
    for m in _CMD_RE.finditer(latex):
        parts.append(("txt", latex[last:m.start()]))
        parts.append(("cmd", m.group()))
        last = m.end()
    parts.append(("txt", latex[last:]))
    out = []
    for kind, val in parts:
        if kind == "cmd":
            out.append(val)
        else:
            out.append(re.sub(r"(?<=[A-Za-z0-9])\s+(?=[A-Za-z0-9])", "", val))
    return "".join(out).strip()


def strip_wrapping(latex: str) -> str:
    """去掉模型偶尔自带的 `$$...$$` / `\\[...\\]` 外壳（前端会自己包）。"""
    s = latex.strip()
    for a, b in (("$$", "$$"), ("\\[", "\\]"), ("\\(", "\\)"), ("$", "$")):
        if len(s) > len(a) + len(b) and s.startswith(a) and s.endswith(b):
            inner = s[len(a):-len(b)]
            # 只在**成对且内部不再嵌套同样外壳**时才剥，避免把 `$x$ + $y$` 剥坏
            if a not in inner:
                return inner.strip()
    return s


def _payload(res):
    """paddleocr 3.x 的 FormulaRecognition 返回 FormulaRecResult，载荷在 .json['res']。"""
    try:
        j = res.json
        if isinstance(j, dict):
            return j.get("res", j)
    except Exception:  # noqa: BLE001
        pass
    if isinstance(res, dict):
        return res
    return {}


# ---------------------------------------------------------------------------
# 模型
# ---------------------------------------------------------------------------
class Recognizer:
    def __init__(self, model_name: str):
        self.model_name = model_name
        self.model = None
        self.load_ms = 0
        self.n = 0
        self.total_ms = 0

    def load(self):
        t0 = time.time()
        # 延迟 import：让 ready 事件尽早发出，前端才知道进程活着（模型还在建）
        from paddleocr import FormulaRecognition

        self.model = FormulaRecognition(model_name=self.model_name)
        # 预热：首帧要建 kernel / 分配 arena，实测比稳态慢 3~5 倍。
        # 不预热的话"第一条公式"永远看起来像卡住了。
        try:
            self._infer(_blank_image())
        except Exception as e:  # noqa: BLE001
            _log(f"[warmup] 预热失败（不影响后续）: {e}")
        self.load_ms = int((time.time() - t0) * 1000)

    def _infer(self, img):
        out = self.model.predict(input=img)
        if not out:
            return "", ""
        res = _payload(out[0])
        raw = str(res.get("rec_formula", "") or "")
        return raw, strip_wrapping(collapse_spaces(raw))

    def recognize(self, image_bytes: bytes):
        from PIL import Image
        import numpy as np

        img = Image.open(io.BytesIO(image_bytes))
        # 模型按 RGB 训练；截图偶尔是 RGBA/P，直接喂会报通道数不对
        if img.mode != "RGB":
            img = img.convert("RGB")
        # 【必须是 ndarray】paddleocr 3.x 的 predict 只认 numpy.ndarray 与 str，
        # 传 PIL.Image 不会报错，而是**静默忽略**：
        #   "Not supported input data type! ... So has been ignored"
        # 然后返回空 list —— 表现是"识别成功但 latex 为空、耗时 0ms"，极难排查。
        arr = np.array(img)
        t0 = time.time()
        raw, latex = self._infer(arr)
        ms = int((time.time() - t0) * 1000)
        self.n += 1
        self.total_ms += ms
        return raw, latex, ms

    def stats(self):
        return {
            "model": self.model_name,
            "loadMs": self.load_ms,
            "count": self.n,
            "avgMs": int(self.total_ms / self.n) if self.n else 0,
        }


def _blank_image():
    from PIL import Image
    import numpy as np

    return np.array(Image.new("RGB", (200, 60), (255, 255, 255)))


# ---------------------------------------------------------------------------
# 主循环
# ---------------------------------------------------------------------------
def _pid_alive(pid: int) -> bool:
    """探测进程是否还活着（**只探测，绝不发信号**）。

    【Windows 上最危险的一行】`os.kill(pid, 0)` 在 POSIX 是"发 0 号信号=只检查"，
    但在 Windows 上 Python 的 os.kill 会走 `TerminateProcess(handle, sig)`——
    传 0 就是**把父进程以退出码 0 结束掉**。这不是探测，是暗杀。

    实测症状：公式模型一启用，打开含公式的 PDF 后扩展宿主十几秒就"意外退出"，
    日志里 exit code 正好是 0；在途的翻译请求全丢，界面永远停在"正在翻译…"。

    Windows 分支改用 OpenProcess + GetExitCodeProcess；任何探测异常都按
    "还活着"处理——宁可 sidecar 多活一会儿，也绝不能再误杀扩展宿主。
    """
    if not pid or pid <= 0:
        return False
    if os.name == "nt":
        try:
            import ctypes
            from ctypes import wintypes

            PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
            STILL_ACTIVE = 259
            kernel32 = ctypes.windll.kernel32
            kernel32.OpenProcess.restype = wintypes.HANDLE
            handle = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, int(pid))
            if not handle:
                # 权限不足时不能断定已退出：可能只是受保护进程
                return False
            code = wintypes.DWORD()
            ok = kernel32.GetExitCodeProcess(handle, ctypes.byref(code))
            kernel32.CloseHandle(handle)
            return bool(ok) and code.value == STILL_ACTIVE
        except Exception:  # noqa: BLE001 - 探测失败时保守地当作还活着
            return True
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def _watch_parent(pid: int):
    """父进程没了就自杀。

    不加这个，扩展宿主崩溃/重载后 sidecar 会变成孤儿进程一直占着 1GB 内存。
    Windows 上用 ctypes 探测（见 _pid_alive），1 秒一次，代价可以忽略。
    """
    if not pid:
        return

    def loop():
        while True:
            time.sleep(1.0)
            if not _pid_alive(pid):
                _log(f"[parent] {pid} 已退出，旁路进程自行退出")
                os._exit(0)

    threading.Thread(target=loop, daemon=True).start()


def main():
    model_name = "PP-FormulaNet_plus-S"
    parent_pid = 0
    for i, a in enumerate(sys.argv):
        if a == "--model" and i + 1 < len(sys.argv):
            model_name = sys.argv[i + 1]
        if a == "--parent-pid" and i + 1 < len(sys.argv):
            try:
                parent_pid = int(sys.argv[i + 1])
            except ValueError:
                parent_pid = 0

    _watch_parent(parent_pid)
    rec = Recognizer(model_name)

    # 先回一条 alive，前端据此判断"Python 起来了、只是模型还没加载完"，
    # 这样才能把"没装 paddle"和"正在加载 1.3GB 权重"区分开。
    _emit({"event": "alive", "pid": os.getpid(), "model": model_name})

    try:
        rec.load()
        _emit({"event": "ready", **rec.stats(), "pid": os.getpid()})
    except Exception as e:  # noqa: BLE001
        _emit({"event": "fatal", "error": f"{type(e).__name__}: {e}",
               "trace": traceback.format_exc()[-1500:]})
        return

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except Exception:  # noqa: BLE001
            continue
        rid = req.get("id")
        cmd = req.get("cmd")

        if cmd == "ping":
            _emit({"id": rid, "ok": True, "pong": True, **rec.stats()})
        elif cmd == "stats":
            _emit({"id": rid, "ok": True, **rec.stats()})
        elif cmd == "shutdown":
            _emit({"id": rid, "ok": True})
            return
        elif cmd == "recognize":
            key = req.get("key")
            try:
                b64 = str(req.get("image_b64") or "")
                if not b64:
                    raise ValueError("image_b64 为空")
                raw_bytes = base64.b64decode(b64, validate=False)
                raw, latex, ms = rec.recognize(raw_bytes)
                _emit({"id": rid, "ok": True, "key": key, "latex": latex, "raw": raw, "ms": ms})
            except Exception as e:  # noqa: BLE001 - 单条失败不能拖垮进程
                _emit({"id": rid, "ok": False, "key": key,
                       "error": f"{type(e).__name__}: {e}"})
        else:
            _emit({"id": rid, "ok": False, "error": f"未知命令: {cmd}"})


if __name__ == "__main__":
    try:
        main()
    except Exception:  # noqa: BLE001
        _log(traceback.format_exc())
        _emit({"event": "fatal", "error": "sidecar crashed", "trace": traceback.format_exc()[-1500:]})
        sys.exit(1)
