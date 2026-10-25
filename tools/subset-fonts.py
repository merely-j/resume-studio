"""把 Noto Sans SC 子集化，只保留简历里会用到的字，体积从 10MB 降到约 1MB。

用法：python tools/subset-fonts.py <输入目录> <输出目录>
"""
import sys
from pathlib import Path

from fontTools import subset
from fontTools.ttLib import TTFont

SRC = Path(sys.argv[1] if len(sys.argv) > 1 else r"D:\ds_workspace\_fonts2\package")
OUT = Path(sys.argv[2] if len(sys.argv) > 2 else r"D:\ds_workspace\resume-app\vendor\fonts")
OUT.mkdir(parents=True, exist_ok=True)


def gb2312_chars():
    """GB2312 全部汉字与符号（6763 汉字 + 682 符号）"""
    chars = set()
    for hi in range(0xA1, 0xF8):
        for lo in range(0xA1, 0xFF):
            try:
                chars.add(bytes([hi, lo]).decode("gb2312"))
            except UnicodeDecodeError:
                pass
    return chars


def build_charset():
    chars = set(chr(c) for c in range(0x20, 0x7F))          # ASCII
    chars |= gb2312_chars()                                  # 常用汉字 + 中文标点
    chars |= set(chr(c) for c in range(0x2010, 0x2030))      # – — ‘ ’ “ ” … 等
    chars |= set(chr(c) for c in range(0x3000, 0x3040))      # 、。《》「」等
    chars |= set(chr(c) for c in range(0xFF01, 0xFF5F))      # 全角字母数字标点
    chars |= set("·×—–°±•→←↑↓√✔✕✗★☆●○■□▲△◆◇№℃€£¥©®™")
    return chars


def subset_font(src: Path, dst: Path, chars: set) -> None:
    font = TTFont(str(src), recalcTimestamp=False)
    options = subset.Options()
    options.layout_features = ["*"]
    options.name_IDs = ["*"]
    options.notdef_outline = True
    options.recalc_bounds = True
    # 保留字形名：pdf-lib 的字体子集化按字形名重映射，去掉名字会导致
    # 数字/字母被映射到错的字形（导出后变成空白或乱码）
    options.glyph_names = True
    options.drop_tables += ["DSIG"]
    subsetter = subset.Subsetter(options=options)
    subsetter.populate(text="".join(sorted(chars)))
    subsetter.subset(font)
    font.save(str(dst))
    font.close()


def main() -> None:
    chars = build_charset()
    print(f"字符集大小: {len(chars)}")

    jobs = [
        ("400Regular/NotoSansSC_400Regular.ttf", "NotoSansSC-Regular.ttf"),
        ("700Bold/NotoSansSC_700Bold.ttf", "NotoSansSC-Bold.ttf"),
    ]
    for src_name, dst_name in jobs:
        src = SRC / src_name
        if not src.exists():
            print(f"跳过（找不到）: {src}")
            continue
        dst = OUT / dst_name
        subset_font(src, dst, chars)
        print(f"{dst_name}: {dst.stat().st_size / 1024 / 1024:.2f} MB")


if __name__ == "__main__":
    main()
