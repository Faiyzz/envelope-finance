"""Generates the PWA icon set (TD-12 §2). Run: python3 scripts/gen-icons.py"""
from PIL import Image, ImageDraw

BG = (79, 70, 229)   # #4f46e5
FG = (255, 255, 255)

def glyph(draw, size, scale):
    # white envelope: body rectangle + flap lines, centred, `scale` of the canvas
    w = size * scale
    h = w * 0.68
    x0 = (size - w) / 2
    y0 = (size - h) / 2
    r = size * 0.04
    draw.rounded_rectangle([x0, y0, x0 + w, y0 + h], radius=r, fill=FG)
    line = max(2, int(size * 0.035))
    cx = size / 2
    draw.line([(x0 + r, y0 + r), (cx, y0 + h * 0.58), (x0 + w - r, y0 + r)], fill=BG, width=line, joint="curve")

def make(size, maskable, path):
    img = Image.new("RGBA", (size, size), BG + (255,))
    d = ImageDraw.Draw(img)
    if not maskable:
        # rounded corners for "any" icons
        mask = Image.new("L", (size, size), 0)
        ImageDraw.Draw(mask).rounded_rectangle([0, 0, size, size], radius=int(size * 0.22), fill=255)
        bg = Image.new("RGBA", (size, size), (0, 0, 0, 0))
        bg.paste(img, (0, 0), mask)
        img = bg
        d = ImageDraw.Draw(img)
    glyph(d, size, 0.50 if maskable else 0.56)   # maskable keeps content in the 80% safe zone
    img.save(path, optimize=True)

make(192, False, "public/icons/icon-192.png")
make(512, False, "public/icons/icon-512.png")
make(192, True, "public/icons/maskable-192.png")
make(512, True, "public/icons/maskable-512.png")
make(180, True, "public/apple-touch-icon.png")
print("ok")
