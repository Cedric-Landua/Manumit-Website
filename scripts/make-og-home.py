"""Render the 1200x630 homepage social preview without hero buttons.

Regenerate from the Website directory with: python scripts/make-og-home.py
Requires Pillow.
"""
import math

from PIL import Image, ImageDraw, ImageFont

W, H = 1200, 630
BACKGROUND = (231, 242, 246)
STRIPE = (218, 233, 239)
TEXT = (32, 42, 48)
ACCENT = (32, 90, 115)
ICON = (91, 137, 155)


def font(size, bold=True):
    names = ("arialbd.ttf", "arial.ttf") if bold else ("arial.ttf",)
    for name in names:
        try:
            return ImageFont.truetype("C:/Windows/Fonts/" + name, size)
        except OSError:
            continue
    return ImageFont.load_default()


def draw_background(img):
    draw = ImageDraw.Draw(img)
    draw.rectangle((0, 0, W, H), fill=BACKGROUND)
    for x in range(-H, W + H, 24):
        draw.line((x, 0, x - H, H), fill=STRIPE, width=1)


def draw_feature(draw, x, y, title, description, kind, label_font, copy_font):
    size = 50
    draw.rounded_rectangle((x, y, x + size, y + size), radius=10,
                           fill=(255, 255, 255), outline=(211, 226, 232), width=1)
    cx, cy = x + size // 2, y + size // 2
    if kind == "lock":
        draw.arc((cx - 7, cy - 13, cx + 7, cy + 6), 180, 360, fill=ICON, width=2)
        draw.rounded_rectangle((cx - 9, cy - 3, cx + 9, cy + 12),
                               radius=3, outline=ICON, width=2)
        draw.line((cx, cy + 2, cx, cy + 7), fill=ICON, width=2)
    elif kind == "star":
        points = []
        for i in range(10):
            angle = -math.pi / 2 + i * math.pi / 5
            radius = 11 if i % 2 == 0 else 5
            points.append((cx + radius * math.cos(angle),
                           cy + radius * math.sin(angle)))
        draw.line(points + [points[0]], fill=ICON, width=2, joint="curve")
    else:
        draw.ellipse((cx - 10, cy - 10, cx + 10, cy + 10), outline=ICON, width=2)
        draw.text((cx, cy), "$", font=font(13), fill=ICON, anchor="mm")

    copy_x = x + size + 12
    draw.text((copy_x, y + 5), title, font=label_font, fill=TEXT)
    draw.text((copy_x, y + 27), description, font=copy_font, fill=(91, 109, 119))


def main():
    img = Image.new("RGB", (W, H), BACKGROUND)
    draw_background(img)
    draw = ImageDraw.Draw(img)
    title_font, label_font, copy_font = font(60), font(16), font(13, bold=False)

    draw.text((250, 176), "Productivity apps", font=title_font, fill=TEXT)
    draw.text((250, 242), "Reimagined", font=title_font, fill=ACCENT)

    draw_feature(draw, 238, 520, "Privacy", "Your data stays yours.",
                 "lock", label_font, copy_font)
    draw_feature(draw, 500, 520, "Quality", "Thoughtfully made.",
                 "star", label_font, copy_font)
    draw_feature(draw, 762, 520, "Free", "No ads. No paywalls.",
                 "free", label_font, copy_font)

    img.save("site/og-home-preview.jpg", "JPEG", quality=88, optimize=True)
    print("wrote site/og-home-preview.jpg")


if __name__ == "__main__":
    main()
