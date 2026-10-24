"""生成 PWA 图标（192 / 512 / maskable）。

用法（在工作区根目录）：
    python tools/make-icons.py

为什么用脚本而不是手画 PNG：
- 改配色或形状时只要重跑一次，不会出现 192 和 512 对不上的情况；
- maskable 图标需要更大的安全边距（Android 会裁成圆形/水滴形），
  同一份代码换个参数就能生成。
"""

from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent.parent / "assets"
TOP = (99, 102, 241)      # #6366f1
BOTTOM = (67, 56, 202)    # #4338ca
ACCENT = (67, 56, 202)    # #4338ca
LIGHT = (199, 210, 254)   # #c7d2fe
S = 1024                  # 先画 1024 再缩小，边缘更干净


def gradient(size: int) -> Image.Image:
    """对角渐变的底：用 numpy 生成比逐像素画快得多。"""
    ramp = np.linspace(0, 1, size)[:, None]
    img = np.zeros((size, size, 3), dtype=np.uint8)
    for i in range(3):
        img[:, :, i] = (TOP[i] * (1 - ramp) + BOTTOM[i] * ramp).astype(np.uint8)
    return Image.fromarray(img, "RGB")


def make_icon(content_scale: float = 1.0, rounded: bool = True) -> Image.Image:
    base = gradient(S).convert("RGBA")

    layer = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)

    pw, ph = int(S * 0.44 * content_scale), int(S * 0.56 * content_scale)
    px, py = (S - pw) // 2, (S - ph) // 2
    d.rounded_rectangle([px, py, px + pw, py + ph], radius=int(pw * 0.1), fill=(255, 255, 255, 246))

    def bar(dx: float, dy: float, dw: float, dh: float, color) -> None:
        x0 = px + dx * pw
        y0 = py + dy * ph
        w = dw * pw
        h = dh * ph
        d.rounded_rectangle([x0, y0, x0 + w, y0 + h], radius=h / 2, fill=color)

    bar(0.16, 0.15, 0.42, 0.055, ACCENT)   # 标题
    bar(0.16, 0.27, 0.62, 0.036, LIGHT)    # 正文
    bar(0.16, 0.35, 0.62, 0.036, LIGHT)
    bar(0.16, 0.43, 0.42, 0.036, LIGHT)
    bar(0.16, 0.56, 0.30, 0.045, ACCENT)   # 小标题
    bar(0.16, 0.66, 0.62, 0.036, LIGHT)
    bar(0.16, 0.74, 0.52, 0.036, LIGHT)

    out = Image.alpha_composite(base, layer)

    if rounded:
        mask = Image.new("L", (S, S), 0)
        ImageDraw.Draw(mask).rounded_rectangle([0, 0, S - 1, S - 1], radius=int(S * 0.22), fill=255)
        out.putalpha(mask)

    return out


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    targets = [
        ("icon-192.png", make_icon(), 192),
        ("icon-512.png", make_icon(), 512),
        # maskable：内容缩到 78%，保证被裁成圆形时不切边
        ("icon-maskable-512.png", make_icon(content_scale=0.78, rounded=False), 512),
    ]
    for name, image, size in targets:
        image.resize((size, size), Image.LANCZOS).save(OUT / name, optimize=True)
        print(f"wrote {OUT / name} ({size}x{size})")


if __name__ == "__main__":
    main()
