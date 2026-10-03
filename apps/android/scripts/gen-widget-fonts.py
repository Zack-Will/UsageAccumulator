#!/usr/bin/env python3
"""
生成小部件用的字体子集（res/font/ua_*.ttf）。

小部件上所有文字都画成位图（TextArt.kt）：小米会把系统主题字体（MiSans）强制套到小部件的
TextView 上，自带字体只能这样用。整套是衬线：
  · 拉丁字母与数字：Source Serif 4（看板 --font-display）
  · 中文：思源宋体 Noto Serif SC —— 它的拉丁字形本就源自 Source Serif，两者放在一起风格一致；
    也正是看板 display 字体栈里中文的回退（"Songti SC", "Noto Serif SC"）

中文只收小部件真会画的字：扫描 Kotlin 源码里**字符串字面量**中的汉字（注释不算）。
服务端下发的新文案里出现子集外的字时，TextArt 回退到系统衬线字体，不会显示成方框。
改了界面文案后重新运行：

    pip install fonttools
    python3 apps/android/scripts/gen-widget-fonts.py \\
        --latin 'SourceSerif4[opsz,wght].ttf' --cjk 'NotoSerifSC[wght].ttf'

两个源文件都来自 github.com/google/fonts（SIL Open Font License 1.1）。
"""
import argparse
import re
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FONT_DIR = ROOT / "app/src/main/res/font"
SRC = ROOT / "app/src/main/java"

# 字重对齐看板：正文 400，标题 600（.card__title），大数字 440（.num--xl）
WEIGHTS = {"regular": 400, "semibold": 600}
# Source Serif 4 的光学尺寸：小字用正文档，大数字用标题档
TEXT_OPSZ = 14
DISPLAY_OPSZ = 36

LATIN_CHARS = "".join(chr(c) for c in range(0x20, 0x7F)) + "—–≥≤·…%$"
DISPLAY_CHARS = "0123456789%-–—.:"
# 源码里不一定以字面量出现、但排版会用到的中文标点
CJK_EXTRA = "（）·，：、—"

STRING_LITERAL = re.compile(r'"((?:[^"\\\n]|\\.)*)"')
CJK = re.compile(r"[　-〿一-鿿＀-￯]")


def cjk_chars() -> str:
    chars = set(CJK_EXTRA)
    for path in SRC.rglob("*.kt"):
        for line in path.read_text(encoding="utf-8").splitlines():
            code = line.split("//", 1)[0]  # 行尾注释不算
            if code.lstrip().startswith("*"):  # KDoc 块里的行
                continue
            for lit in STRING_LITERAL.findall(code):
                chars.update(CJK.findall(lit))
    return "".join(sorted(chars))


def run(*args: str) -> None:
    subprocess.run(args, check=True)


def instance_and_subset(src: str, axes: dict, text: str, out: Path, features: str) -> None:
    with tempfile.TemporaryDirectory() as tmp:
        inst = Path(tmp) / "inst.ttf"
        run(sys.executable, "-m", "fontTools.varLib.instancer", src,
            *[f"{k}={v}" for k, v in axes.items()], "-o", str(inst), "-q")
        run(sys.executable, "-m", "fontTools.subset", str(inst), f"--text={text}",
            f"--layout-features={features}", f"--output-file={out}")
    print(f"{out.name}: {out.stat().st_size / 1024:.1f} KB")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--latin", required=True, help="SourceSerif4[opsz,wght].ttf")
    ap.add_argument("--cjk", required=True, help="NotoSerifSC[wght].ttf")
    a = ap.parse_args()

    FONT_DIR.mkdir(parents=True, exist_ok=True)
    cjk = cjk_chars()
    print(f"中文 {len(cjk)} 字：{cjk}")

    instance_and_subset(a.latin, {"wght": 440, "opsz": DISPLAY_OPSZ}, DISPLAY_CHARS,
                        FONT_DIR / "ua_display.ttf", "tnum,lnum,kern")
    for name, w in WEIGHTS.items():
        instance_and_subset(a.latin, {"wght": w, "opsz": TEXT_OPSZ}, LATIN_CHARS,
                            FONT_DIR / f"ua_serif_latin_{name}.ttf", "tnum,lnum,kern,liga")
        instance_and_subset(a.cjk, {"wght": w}, cjk,
                            FONT_DIR / f"ua_serif_cjk_{name}.ttf", "kern,palt")


if __name__ == "__main__":
    main()
