"""冒烟测试：起 sidecar，把已有裁图喂进去，看协议是否通、速度多少。

用法：
    python py/test_sidecar.py PP-FormulaNet_plus-S
    python py/test_sidecar.py PP-FormulaNet_plus-L --dir ../formula_model_probe/out --limit 20

只测**协议与吞吐**，不判对错——对错看 formula_model_probe/FINDINGS.md 的对照表。
"""

import glob
import json
import os
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
SIDECAR = HERE / "formula_sidecar.py"

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass


def main():
    model = sys.argv[1] if len(sys.argv) > 1 else "PP-FormulaNet_plus-S"
    # 默认样本目录在交付包根下（academic-pdf-reader/ 的兄弟目录），不是扩展目录内
    src_dir = HERE.parent.parent / "formula_model_probe" / "out"
    limit = 0
    for i, a in enumerate(sys.argv):
        if a == "--dir" and i + 1 < len(sys.argv):
            src_dir = Path(sys.argv[i + 1])
        if a == "--limit" and i + 1 < len(sys.argv):
            limit = int(sys.argv[i + 1])

    images = sorted(glob.glob(str(src_dir / "crop_*.png")))
    if limit:
        images = images[:limit]
    print(f"样本 {len(images)} 张，模型 {model}", flush=True)

    proc = subprocess.Popen(
        # 必须带上 --parent-pid：父进程存活检查是 Windows 上最容易误杀扩展宿主的一步，
        # 测试里把它跑起来，回归时才能复现（sidecar 只会探测测试进程，不会影响 IDE）。
        [sys.executable, str(SIDECAR), "--model", model, "--parent-pid", str(os.getpid())],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        text=True, encoding="utf-8", errors="replace", bufsize=1,
    )

    def read_msg(timeout=600):
        # 阻塞读一行；sidecar 保证每条消息都 flush，不会卡在缓冲上
        line = proc.stdout.readline()
        if not line:
            err = proc.stderr.read()[-2000:] if proc.poll() is not None else ""
            raise SystemExit(f"sidecar 提前退出:\n{err}")
        return json.loads(line)

    t0 = time.time()
    while True:
        msg = read_msg()
        if msg.get("event") == "alive":
            print(f"  alive pid={msg['pid']}，等模型加载…", flush=True)
        elif msg.get("event") == "ready":
            print(f"  ready 加载 {msg['loadMs']}ms（含预热，总 {int((time.time()-t0)*1000)}ms）", flush=True)
            break
        elif msg.get("event") == "fatal":
            print("  fatal:", msg.get("error"))
            print(msg.get("trace", ""))
            proc.kill()
            return

    total, fails = 0, 0
    for idx, path in enumerate(images):
        b64 = __import__("base64").b64encode(Path(path).read_bytes()).decode()
        req = {"id": idx + 1, "cmd": "recognize", "key": Path(path).stem, "image_b64": b64}
        proc.stdin.write(json.dumps(req) + "\n")
        proc.stdin.flush()
        resp = read_msg()
        if resp.get("ok"):
            total += resp.get("ms", 0)
            print(f"  {resp['key']:28s} {resp['ms']:5d}ms  {resp['latex'][:70]!r}", flush=True)
        else:
            fails += 1
            print(f"  {resp.get('key'):28s} FAIL {resp.get('error')}", flush=True)

    n = len(images) - fails
    print(f"\n完成 {n}/{len(images)}，平均 {int(total / n) if n else 0}ms/张，失败 {fails}")

    proc.stdin.write(json.dumps({"id": 9999, "cmd": "shutdown"}) + "\n")
    proc.stdin.flush()
    try:
        proc.wait(timeout=10)
    except subprocess.TimeoutExpired:
        proc.kill()


if __name__ == "__main__":
    main()
