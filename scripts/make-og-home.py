"""Render site/og-home.png -- static 1200x630 social preview matching the
homepage horizon hero (Quality. / Private. / Free. + tagline, starfield,
Earth horizon arc, rocket mid-ascent) WITHOUT the Browse/Donate buttons.

Regenerate:  python scripts/make-og-home.py
Requires:   Pillow (already installed: 12.3.0)
"""
import random
from PIL import Image, ImageDraw, ImageFont, ImageFilter

W, H = 1200, 630
NAVY_TOP, NAVY_MID, NAVY_BOT = (12, 16, 34), (20, 26, 51), (29, 37, 71)
WHITE = (255, 255, 255)
AMBER = (237, 165, 45)
LEDE = (208, 213, 228)
EARTH_TOP = (13, 23, 64)
LAND_A, LAND_B = (43, 106, 82), (63, 143, 106)

random.seed(20261010)


def font(size, bold=True):
    for name in (("arialbd.ttf", "arial.ttf") if bold else ("arial.ttf",)):
        for path in ("C:/Windows/Fonts/" + name,):
            try:
                return ImageFont.truetype(path, size)
            except OSError:
                continue
    return ImageFont.load_default()


def vgrad(draw, top, mid, bot):
    for y in range(H):
        t = y / (H - 1)
        if t < 0.55:
            k = t / 0.55
            c = tuple(round(top[i] + (mid[i] - top[i]) * k) for i in range(3))
        else:
            k = (t - 0.55) / 0.45
            c = tuple(round(mid[i] + (bot[i] - mid[i]) * k) for i in range(3))
        draw.line([(0, y), (W, y)], fill=c)


def stars(base):
    d = ImageDraw.Draw(base)
    for _ in range(120):
        x, y = random.uniform(0, W), random.uniform(0, H * 0.72)
        r = random.choice([0.7, 0.9, 1.1, 1.4])
        a = random.randint(70, 200)
        d.ellipse([x - r, y - r, x + r, y + r], fill=(255, 255, 255, a))
    for _ in range(8):
        x, y = random.uniform(0, W), random.uniform(0, H * 0.5)
        d.ellipse([x - 1.4, y - 1.4, x + 1.4, y + 1.4],
                  fill=(255, 217, 122, 170))
    return base


def text_glow(base, xy, s, fnt, fill, glow, radius=18, glow_alpha=110):
    g = Image.new("RGBA", base.size, (0, 0, 0, 0))
    gd = ImageDraw.Draw(g)
    gd.text(xy, s, font=fnt, fill=glow + (glow_alpha,))
    g = g.filter(ImageFilter.GaussianBlur(radius))
    base.alpha_composite(g)
    ImageDraw.Draw(base).text(xy, s, font=fnt, fill=fill + (255,))


def earth(base):
    d = ImageDraw.Draw(base)
    cx, cy, r = W * 0.74, H + 560, 660
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=EARTH_TOP)
    blobs = [(cx - 260, H - 14, 150, 22, LAND_A),
             (cx + 40, H - 10, 190, 24, LAND_A),
             (cx + 330, H - 16, 110, 18, LAND_A),
             (cx - 200, H - 6, 90, 13, LAND_B),
             (cx + 120, H - 4, 110, 14, LAND_B),
             (cx + 360, H - 6, 60, 10, LAND_B)]
    for (x, y, rx, ry, col) in blobs:
        d.ellipse([x - rx, y - ry, x + rx, y + ry], fill=col)
    for off, alpha in ((0, 90), (5, 50), (11, 28)):
        d.arc([cx - r + off, cy - r + off, cx + r - off, cy + r - off],
              start=180, end=360, fill=(188, 216, 255, alpha), width=3)
    px, py = cx - 80, H - 40
    glow = Image.new("RGBA", base.size, (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    for rad, alpha in ((90, 60), (60, 110), (34, 170)):
        gd.ellipse([px - rad, py - rad * 0.55, px + rad, py + rad * 0.55],
                   fill=(255, 200, 110, alpha))
    base.alpha_composite(glow.filter(ImageFilter.GaussianBlur(18)))
    return px, py


def rocket_burst(base, px, py):
    d = ImageDraw.Draw(base)
    rx, ry, s = px, py - 150, 1.0
    for (w, h, col) in ((26, 120, (255, 111, 46, 120)),
                        (18, 92, (255, 171, 69, 200)),
                        (11, 64, (255, 251, 232, 235))):
        d.polygon([(rx - w / 2, ry + 22 * s), (rx + w / 2, ry + 22 * s),
                   (rx, ry + 22 * s + h)], fill=col)
    d.ellipse([rx - 13, ry + 14 * s, rx + 13, ry + 30 * s],
              fill=(255, 207, 110, 220))
    bw, bh = 16 * s, 74 * s
    d.rectangle([rx - bw / 2, ry - bh, rx + bw / 2, ry + 16 * s],
                fill=(238, 242, 251))
    d.rectangle([rx - bw / 2, ry - bh, rx - bw / 2 + 5 * s, ry + 16 * s],
                fill=(185, 196, 222))
    d.rectangle([rx - bw / 2, ry - bh, rx + bw / 2, ry - bh + 12 * s],
                fill=(24, 34, 66))
    d.rectangle([rx - bw / 2, ry + 2 * s, rx + bw / 2, ry + 8 * s],
                fill=(237, 165, 45))
    d.polygon([(rx - bw / 2, ry - bh), (rx + bw / 2, ry - bh),
               (rx, ry - bh - 22 * s)], fill=(238, 242, 251))
    d.line([(rx, ry - bh - 22 * s), (rx, ry - bh - 36 * s)],
           fill=(201, 212, 234), width=2)
    for side in (-1, 1):
        bx = rx + side * 15 * s
        d.rectangle([bx - 5 * s, ry - bh + 22 * s, bx + 5 * s, ry + 16 * s],
                    fill=(242, 246, 255))
        d.polygon([(bx - 5 * s, ry - bh + 22 * s),
                   (bx + 5 * s, ry - bh + 22 * s), (bx, ry - bh + 8 * s)],
                  fill=(238, 242, 251))
        d.rectangle([bx - 5 * s, ry + 6 * s, bx + 5 * s, ry + 10 * s],
                    fill=(237, 165, 45))
        d.polygon([(bx - 5 * s, ry + 8 * s), (bx + 5 * s, ry + 8 * s),
                   (bx + side * 2 * s, ry + 26 * s)],
                  fill=(255, 171, 69, 220))
    for (ox, rad, alpha) in ((-70, 34, 90), (60, 40, 80),
                             (-30, 26, 110), (30, 30, 100)):
        d.ellipse([px + ox - rad, py - rad * 0.7,
                   px + ox + rad, py + rad * 0.7],
                  fill=(233, 240, 255, alpha))


def main():
    img = Image.new("RGBA", (W, H), NAVY_TOP + (255,))
    d = ImageDraw.Draw(img)
    vgrad(d, NAVY_TOP, NAVY_MID, NAVY_BOT)
    stars(img)
    f_big, f_lede = font(118), font(27, bold=False)
    x, y = 88, 92
    for line in ("Quality.", "Private."):
        text_glow(img, (x, y), line, f_big, WHITE, WHITE, 14, 40)
        y += 122
    text_glow(img, (x, y), "Free.", f_big, AMBER, AMBER, 22, 130)
    ly = y + 138
    d.text((x, ly), "Empowering the next generation of go-getters,",
           font=f_lede, fill=LEDE + (255,))
    d.text((x, ly + 36), "expectation setters, and landscape definers.",
           font=f_lede, fill=LEDE + (255,))
    px, py = earth(img)
    rocket_burst(img, px, py)
    # JPEG q82: ~100-150KB vs 914KB PNG. OG scrapers universally accept
    # image/jpeg; PNG kept only as fallback during the transition.
    img.convert("RGB").save("site/og-home.jpg", "JPEG", quality=82, optimize=True)
    print("wrote site/og-home.jpg")


if __name__ == "__main__":
    main()

