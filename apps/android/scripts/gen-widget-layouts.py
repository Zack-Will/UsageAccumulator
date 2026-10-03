#!/usr/bin/env python3
"""
生成小部件布局。两种样式 × 两档密度：

  卡片（看板额度卡的桌面版）：widget_card1 / widget_card2（一张 / 两张并排）
  列表（信息密度更高，一个窗口一行）：widget_list / widget_list_narrow（2 列宽时每行拆两层）
  密度：紧凑（按小米最小尺寸 110dp 高排）/ 宽松（_roomy，格子 ≥ 150dp 高时用）

同一样式的几份布局结构完全一样、只有间距不同，而且 view id 必须逐个对齐
（UsageWidget.kt 用同一套 id 绑定）。手写迟早会漂，所以由这个脚本生成。改完运行：

    python3 apps/android/scripts/gen-widget-layouts.py

**所有文字都是 ImageView**，由 TextArt.kt 画成衬线字位图：小米会把系统主题字体（MiSans）
强制套到小部件的 TextView 上（ro.miui.ui.font.theme_apply）。所以这里只管位置和间距，
字号由 UsageWidget.kt 的 Type 按密度给。
"""
from pathlib import Path

RES = Path(__file__).resolve().parent.parent / "app/src/main/res/layout"
TONES = ("ok", "warn", "danger", "muted")
LIST_ROWS = 4

# 小米设计规范（2K 屏）：安全边距 ≥ 55px ≈ 15dp。宽松档按它来；紧凑档只在格子比规范还小时才用，只能再收
CARD = {
    "compact": dict(pad=10, gap=20, bar=8, tick=12, num_top=2, bar_top=4, eta_top=4),
    "roomy": dict(pad=16, gap=24, bar=10, tick=16, num_top=4, bar_top=8, eta_top=6, money=True, money_top=8),
}
LIST = {
    "compact": dict(pad=10, label_w=52, num_w=44, bar=6, tick=10, eta_w=84, row_gap=2),
    "roomy": dict(pad=16, label_w=60, num_w=54, bar=8, tick=14, eta_w=96, row_gap=6),
}
# 窄列表（2 列宽）：横向放不下「标题 + 数字 + 条」，每行拆成两层——上面标题和数字，下面一整条
NARROW = {
    "compact": dict(pad=10, bar=6, tick=10, bar_top=2, row_gap=4),
    "roomy": dict(pad=16, bar=8, tick=12, bar_top=4, row_gap=8),
}

NL = "\n"


# 生成浅色（layout/）还是深色（layout-night/）那一份；img() 按它决定两张位图谁可见
NIGHT = False


def img(vid: str, indent: str, width: str = "wrap_content", extra: tuple = ()) -> str:
    """
    一段文字：一个容器 + 两张位图（浅色 _d、深色 _n），颜色已经画在位图里。

    为什么不用一张白字 + 着色：HyperOS 桌面（Flutter + Rust 重写的 RemoteViews 渲染器）
    调整大小后会丢掉所有着色指令，白字画在白卡片上，实测整块小部件的文字全部「消失」。
    深浅色改由布局资源限定符切换：layout/ 里只显示 _d，layout-night/ 里只显示 _n，
    桌面按自己的深浅色选布局，不需要任何运行时指令。代码只对容器 id 做显隐。

    scaleType=matrix：按位图原尺寸从左上角画，**绝不缩放**——
    fitStart/adjustViewBounds 会按可用宽度把字放大或缩小（实测标题被放大到占满半张卡）。
    """
    attrs = "".join(f"{NL}{indent}    {a}" for a in extra)
    day_vis = ' android:visibility="gone"' if NIGHT else ""
    night_vis = "" if NIGHT else ' android:visibility="gone"'
    return f'''
{indent}<FrameLayout
{indent}    android:id="@+id/{vid}"
{indent}    android:layout_width="{width}"
{indent}    android:layout_height="wrap_content"{attrs}>
{indent}    <ImageView android:id="@+id/{vid}_d" android:layout_width="wrap_content" android:layout_height="wrap_content" android:scaleType="matrix"{day_vis} />
{indent}    <ImageView android:id="@+id/{vid}_n" android:layout_width="wrap_content" android:layout_height="wrap_content" android:scaleType="matrix"{night_vis} />
{indent}</FrameLayout>'''


def bars(p: str, height: int, tick: int, indent: str) -> str:
    out = "".join(f'''
{indent}<ProgressBar
{indent}    android:id="@+id/{p}_bar_{t}"
{indent}    style="@style/UaWidgetBar"
{indent}    android:layout_width="match_parent"
{indent}    android:layout_height="{height}dp"
{indent}    android:layout_gravity="center_vertical"
{indent}    android:maxHeight="{height}dp"
{indent}    android:minHeight="{height}dp"
{indent}    android:progressDrawable="@drawable/qbar_{t}"
{indent}    android:visibility="gone" />''' for t in TONES)
    return out + f'''

{indent}<ProgressBar
{indent}    android:id="@+id/{p}_pace"
{indent}    style="@style/UaWidgetBar"
{indent}    android:layout_width="match_parent"
{indent}    android:layout_height="match_parent"
{indent}    android:maxHeight="{tick}dp"
{indent}    android:minHeight="{tick}dp"
{indent}    android:progressDrawable="@drawable/qbar_pace"
{indent}    android:visibility="gone" />'''


def eta(p: str, indent: str) -> str:
    return f'''
{indent}<ImageView
{indent}    android:id="@+id/{p}_dot"
{indent}    android:layout_width="6dp"
{indent}    android:layout_height="6dp"
{indent}    android:layout_marginEnd="6dp"
{indent}    android:importantForAccessibility="no"
{indent}    android:visibility="gone" />
{img(f"{p}_eta", indent)}'''


def money(p: str, d: dict) -> str:
    """
    看板额度卡的 .quota__money：一条细线 + 左右两栏，每栏上标签下数字
    （已用 $32.34 ｜ 满额约 $216）。挤成一行在半张 4×2 宽里放不下。只进宽松档
    """
    if not d.get("money"):
        return ""

    def col(key: str, gravity: str) -> str:
        return f'''
            <LinearLayout
                android:layout_width="wrap_content"
                android:layout_height="wrap_content"
                android:gravity="{gravity}"
                android:orientation="vertical">
{img(f"{p}_{key}_label", "                ")}
{img(f"{p}_{key}", "                ", extra=('android:layout_marginTop="2dp"',))}
            </LinearLayout>'''

    return f'''

        <FrameLayout
            android:layout_width="match_parent"
            android:layout_height="1dp"
            android:layout_marginTop="{d['money_top']}dp"
            android:background="@color/ua_border" />

        <LinearLayout
            android:layout_width="match_parent"
            android:layout_height="wrap_content"
            android:layout_marginTop="{d['money_top'] - 2}dp"
            android:orientation="horizontal">
{col("spend", "start")}

            <FrameLayout
                android:layout_width="0dp"
                android:layout_height="1dp"
                android:layout_weight="1" />
{col("full", "end")}
        </LinearLayout>'''


def card(p: str, d: dict, width: str, margin_start: int = 0) -> str:
    ms = f'\n        android:layout_marginStart="{margin_start}dp"' if margin_start else ""
    return f'''    <LinearLayout
        android:id="@+id/{p}"
        {width}{ms}
        android:orientation="vertical">

        <LinearLayout
            android:layout_width="match_parent"
            android:layout_height="wrap_content"
            android:gravity="center_vertical"
            android:orientation="horizontal">
{img(f"{p}_label", "            ", width="0dp", extra=('android:layout_weight="1"',))}
{img(f"{p}_status", "            ", extra=('android:layout_marginStart="6dp"',))}
        </LinearLayout>

        <!-- 底边对齐：大数字位图在基线下留了与「预计」同样的高度，底边齐即基线齐 -->
        <LinearLayout
            android:layout_width="match_parent"
            android:layout_height="wrap_content"
            android:layout_marginTop="{d['num_top']}dp"
            android:gravity="bottom"
            android:orientation="horizontal">
{img(f"{p}_pct", "            ")}

            <FrameLayout
                android:layout_width="0dp"
                android:layout_height="1dp"
                android:layout_weight="1" />

            <LinearLayout
                android:id="@+id/{p}_proj"
                android:layout_width="wrap_content"
                android:layout_height="wrap_content"
                android:gravity="bottom"
                android:orientation="horizontal">
{img(f"{p}_proj_label", "                ", extra=('android:layout_marginEnd="4dp"',))}
{img(f"{p}_proj_val", "                ")}
            </LinearLayout>
        </LinearLayout>

        <!-- 额度条 + 比它高出一截的时间刻度（看板 .qbar / .qbar__pace） -->
        <FrameLayout
            android:layout_width="match_parent"
            android:layout_height="{d['tick']}dp"
            android:layout_marginTop="{d['bar_top']}dp">
{bars(p, d['bar'], d['tick'], "            ")}
        </FrameLayout>

        <LinearLayout
            android:layout_width="match_parent"
            android:layout_height="wrap_content"
            android:layout_marginTop="{d['eta_top']}dp"
            android:gravity="center_vertical"
            android:orientation="horizontal">
{eta(p, "            ")}
        </LinearLayout>{money(p, d)}
    </LinearLayout>
'''


def list_row(i: int, d: dict) -> str:
    p = f"r{i}"
    return f'''
        <LinearLayout
            android:id="@+id/{p}"
            android:layout_width="match_parent"
            android:layout_height="0dp"
            android:layout_marginTop="{d['row_gap']}dp"
            android:layout_weight="1"
            android:gravity="center_vertical"
            android:orientation="horizontal"
            android:visibility="gone">

            <FrameLayout
                android:layout_width="{d['label_w']}dp"
                android:layout_height="wrap_content">
{img(f"{p}_label", "                ", extra=('android:layout_gravity="start|center_vertical"',))}
            </FrameLayout>

            <FrameLayout
                android:layout_width="{d['num_w']}dp"
                android:layout_height="wrap_content">
{img(f"{p}_pct", "                ", extra=('android:layout_gravity="start|center_vertical"',))}
            </FrameLayout>

            <FrameLayout
                android:layout_width="0dp"
                android:layout_height="{d['tick']}dp"
                android:layout_weight="1">
{bars(p, d['bar'], d['tick'], "                ")}
            </FrameLayout>

            <LinearLayout
                android:id="@+id/{p}_eta_box"
                android:layout_width="{d['eta_w']}dp"
                android:layout_height="wrap_content"
                android:gravity="end|center_vertical"
                android:orientation="horizontal">
{eta(p, "                ")}
            </LinearLayout>
        </LinearLayout>'''


def narrow_row(i: int, d: dict) -> str:
    p = f"r{i}"
    return f'''
        <LinearLayout
            android:id="@+id/{p}"
            android:layout_width="match_parent"
            android:layout_height="0dp"
            android:layout_marginTop="{d['row_gap']}dp"
            android:layout_weight="1"
            android:gravity="center_vertical"
            android:orientation="vertical"
            android:visibility="gone">

            <LinearLayout
                android:layout_width="match_parent"
                android:layout_height="wrap_content"
                android:gravity="center_vertical"
                android:orientation="horizontal">
{img(f"{p}_label", "                ", width="0dp", extra=('android:layout_weight="1"',))}
{img(f"{p}_pct", "                ")}
            </LinearLayout>

            <FrameLayout
                android:layout_width="match_parent"
                android:layout_height="{d['tick']}dp"
                android:layout_marginTop="{d['bar_top']}dp">
{bars(p, d['bar'], d['tick'], "                ")}
            </FrameLayout>

            <!-- 窄列表不放时刻；留着这些 id 只为与宽列表共用同一套绑定代码 -->
            <LinearLayout
                android:id="@+id/{p}_eta_box"
                android:layout_width="wrap_content"
                android:layout_height="wrap_content"
                android:visibility="gone">
{eta(p, "                ")}
            </LinearLayout>
        </LinearLayout>'''


HEADER = '''<?xml version="1.0" encoding="utf-8"?>
<!--
  由 apps/android/scripts/gen-widget-layouts.py 生成（{what}），不要手改。
  layout/ 与 layout-night/ 各一份，只差文字位图的浅色 / 深色哪张可见。
  小米规范：根布局必须是 @android:id/background，且背景不能全透明。
-->
'''


def card_shell(body: str, d: dict, what: str) -> str:
    return HEADER.format(what=what) + f'''<LinearLayout xmlns:android="http://schemas.android.com/apk/res/android"
    android:id="@android:id/background"
    android:layout_width="match_parent"
    android:layout_height="match_parent"
    android:background="@drawable/widget_bg"
    android:gravity="center_vertical"
    android:orientation="horizontal"
    android:padding="{d['pad']}dp">

{body}</LinearLayout>
'''


def list_shell(d: dict, what: str, row=list_row) -> str:
    rows = "\n".join(row(i, d) for i in range(LIST_ROWS))
    return HEADER.format(what=what) + f'''<LinearLayout xmlns:android="http://schemas.android.com/apk/res/android"
    android:id="@android:id/background"
    android:layout_width="match_parent"
    android:layout_height="match_parent"
    android:background="@drawable/widget_bg"
    android:orientation="vertical"
    android:padding="{d['pad']}dp">

    <LinearLayout
        android:layout_width="match_parent"
        android:layout_height="wrap_content"
        android:gravity="center_vertical"
        android:orientation="horizontal">
{img("list_title", "        ", width="0dp", extra=('android:layout_weight="1"',))}
{img("list_status", "        ")}
    </LinearLayout>

    <LinearLayout
        android:layout_width="match_parent"
        android:layout_height="0dp"
        android:layout_weight="1"
        android:orientation="vertical">
{rows}

        <FrameLayout
            android:id="@+id/list_empty"
            android:layout_width="match_parent"
            android:layout_height="0dp"
            android:layout_weight="1"
            android:visibility="gone">
{img("list_empty_text", "            ", extra=('android:layout_gravity="start|center_vertical"',))}
        </FrameLayout>
    </LinearLayout>
</LinearLayout>
'''


def write_all(out: Path) -> None:
    out.mkdir(parents=True, exist_ok=True)
    full = 'android:layout_width="match_parent"\n        android:layout_height="wrap_content"'
    half = 'android:layout_width="0dp"\n        android:layout_height="wrap_content"\n        android:layout_weight="1"'
    for density, d in CARD.items():
        sfx = "" if density == "compact" else "_roomy"
        one = card("c0", d, full)
        two = card("c0", d, half) + "\n" + card("c1", d, half, margin_start=d["gap"])
        (out / f"widget_card1{sfx}.xml").write_text(card_shell(one, d, f"卡片 ×1 · {density}"), encoding="utf-8")
        (out / f"widget_card2{sfx}.xml").write_text(card_shell(two, d, f"卡片 ×2 · {density}"), encoding="utf-8")
    for density, d in LIST.items():
        sfx = "" if density == "compact" else "_roomy"
        (out / f"widget_list{sfx}.xml").write_text(list_shell(d, f"列表 · {density}"), encoding="utf-8")
    for density, d in NARROW.items():
        sfx = "" if density == "compact" else "_roomy"
        (out / f"widget_list_narrow{sfx}.xml").write_text(
            list_shell(d, f"窄列表 · {density}", row=narrow_row), encoding="utf-8")


def main() -> None:
    global NIGHT
    for night, out in ((False, RES), (True, RES.parent / "layout-night")):
        NIGHT = night
        write_all(out)
    print("ok:", ", ".join(sorted(p.name for p in RES.glob("widget_*.xml"))), "（layout/ 与 layout-night/ 各一份）")


if __name__ == "__main__":
    main()
