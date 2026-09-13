# 图标一次性生成脚本（Pillow 只是本机生成工具，不是项目依赖）。
# 用法：python3 apps/desktop/scripts/gen_icons.py
from PIL import Image, ImageDraw
import os, subprocess

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "src-tauri", "icons")
os.makedirs(OUT, exist_ok=True)

PRIMARY = (79, 70, 229, 255)      # --primary #4F46E5
PRIMARY_DEEP = (67, 56, 202, 255)  # --primary-hover #4338CA
SURFACE = (255, 255, 255, 255)
REVIEW = (139, 92, 246, 255)       # 待审核 #8B5CF6
RUNNING = (245, 158, 11, 255)      # 执行中 #F59E0B
DONE = (16, 185, 129, 255)         # 已完成 #10B981


def rounded_appicon(size: int) -> Image.Image:
    scale = size / 512
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    r = int(112 * scale)
    d.rounded_rectangle([0, 0, size - 1, size - 1], radius=r, fill=PRIMARY)
    d.rounded_rectangle([0, int(size * 0.55), size - 1, size - 1], radius=r, fill=PRIMARY_DEEP)
    # 三列看板
    pad = int(64 * scale)
    gap = int(28 * scale)
    col_w = (size - 2 * pad - 2 * gap) // 3
    top = int(96 * scale)
    bottom = size - int(64 * scale)
    heights = [(int(0.30 * size)), (int(0.52 * size)), (int(0.20 * size))]
    accents = [SURFACE, RUNNING, DONE]

    # 半透明面板单独画在图层上再合成，避免 PIL 直接写半透明像素
    panel = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    pd = ImageDraw.Draw(panel)
    for i in range(3):
        x0 = pad + i * (col_w + gap)
        pd.rounded_rectangle([x0, top, x0 + col_w, bottom], radius=int(28 * scale), fill=(255, 255, 255, 42))
    img = Image.alpha_composite(img, panel)
    d = ImageDraw.Draw(img)

    card_h = int(72 * scale)
    card_r = int(16 * scale)
    edge = (30, 27, 90, 60)
    for i in range(3):
        x0 = pad + i * (col_w + gap)
        y = top + int(20 * scale)
        n = max(1, int(heights[i] / (card_h + int(18 * scale))))
        for k in range(n):
            if y + card_h > bottom - int(12 * scale):
                break
            fill = REVIEW if (i == 1 and k == 1) else accents[i]
            d.rounded_rectangle([x0 + int(14 * scale), y, x0 + col_w - int(14 * scale), y + card_h],
                                radius=card_r, fill=fill, outline=edge, width=max(1, int(2 * scale)))
            y += card_h + int(18 * scale)
    return img


def tray_glyph(size: int, color) -> Image.Image:
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    scale = size / 32
    lw = max(1, int(2.6 * scale))
    m = int(3 * scale)
    left, top = m, m
    right, bottom = size - 1 - m, size - 1 - m
    d.rounded_rectangle([left, top, right, bottom], radius=int(6 * scale), outline=color, width=lw)

    inner_w = right - left
    col_w = inner_w / 3.0
    for i in (1, 2):
        x = int(left + col_w * i)
        d.line([(x, top + int(4 * scale)), (x, bottom - int(4 * scale))],
               fill=color, width=max(1, int(2 * scale)))

    # 每列里的小卡片：坐标全部按列宽推导，尺寸过小自动跳过
    pad = max(1, int(3 * scale))
    card_h = max(2, int(4 * scale))
    card_gap = max(2, int(3 * scale))
    rows_per_col = {0: 3, 1: 2, 2: 1}
    for i in range(3):
        x0 = int(left + col_w * i) + pad
        x1 = int(left + col_w * (i + 1)) - pad
        y = top + pad
        for _ in range(rows_per_col[i]):
            y1 = y + card_h
            if x1 > x0 and y1 <= bottom - pad:
                d.rectangle([x0, y, x1, y1], fill=color)
            y += card_h + card_gap
    return img


for size in (1024, 512, 256, 128, 64, 32, 16):
    rounded_appicon(size).save(f"{OUT}/appicon-{size}.png")

rounded_appicon(512).save(f"{OUT}/icon.png")
rounded_appicon(32).save(f"{OUT}/32x32.png")
rounded_appicon(128).save(f"{OUT}/128x128.png")

BLACK = (17, 17, 17, 255)
tray_glyph(32, BLACK).save(f"{OUT}/tray-icon.png")
tray_glyph(16, BLACK).save(f"{OUT}/tray-icon-16.png")
tray_glyph(32, (239, 68, 68, 255)).save(f"{OUT}/tray-icon-error.png")

# .icns（macOS 应用图标）：iconutil 需要一个临时 .iconset 目录
import shutil, tempfile

icon_dir = tempfile.mkdtemp(suffix=".iconset")
pairs = {
    "icon_16x16.png": 16, "icon_16x16@2x.png": 32,
    "icon_32x32.png": 32, "icon_32x32@2x.png": 64,
    "icon_128x128.png": 128, "icon_128x128@2x.png": 256,
    "icon_256x256.png": 256, "icon_256x256@2x.png": 512,
    "icon_512x512.png": 512, "icon_512x512@2x.png": 1024,
}
for name, size in pairs.items():
    Image.open(f"{OUT}/appicon-{size}.png").save(f"{icon_dir}/{name}")
subprocess.run(["iconutil", "-c", "icns", icon_dir, "-o", f"{OUT}/icon.icns"], check=True)
shutil.rmtree(icon_dir, ignore_errors=True)
print(sorted(os.listdir(OUT)))
