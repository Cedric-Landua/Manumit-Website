"""Render site/icon.png (512x512) + site/icon-180.png (apple touch) from the
bird paths in site/favicon.svg — full-bleed navy, bird at ~92% width so it
fills Google's cropped search circle. Pillow only (no cairo needed).

Run from Website/:  python scripts/make-icon-png.py
"""
import re
from pathlib import Path
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
SVG = ROOT / "site" / "favicon.svg"
NAVY = (52, 66, 113)
SIZE = 512

# Same transform chain as favicon.svg: outer translate+scale, then the
# inner 1024x572 flip (translate(0,572) scale(0.1,-0.1)).
SX, SY = -43.4, 20.1
K = 0.583

def parse_paths():
    raw = SVG.read_text(encoding="utf-8", errors="replace")
    # grab every d="..." path (bird artwork only — no other paths in file)
    return re.findall(r'<path\s+d="([^"]+)"', raw)

def tokenize(d):
    return re.findall(r"[MmLlHhVvCcQqSsTtAaZz]|-?\d*\.?\d+(?:e-?\d+)?", d)

def draw_path(draw, d, fill):
    toks = tokenize(d)
    i, cx, cy, sx, sy = 0, 0.0, 0.0, 0.0, 0.0
    cmd = ""
    sub = []
    polys = []

    def flush():
        if len(sub) >= 3:
            polys.append(list(sub))
        sub.clear()

    def pt(x, y):
        # inner flip then outer scale/translate
        ix, iy = x * 0.1, (572 - y) * 0.1
        return (SX + ix * K * 10, SY + iy * K * 10)

    while i < len(toks):
        t = toks[i]
        if re.fullmatch(r"[A-Za-z]", t):
            cmd = t
            i += 1
            if cmd in "Zz":
                flush()
            continue
        n = float(t)
        if cmd in "Mm":
            rel = cmd == "m"
            x = (cx + n) if rel else n
            y = (cy + float(toks[i + 1])) if rel else float(toks[i + 1])
            i += 2
            cx, cy = (x, y) if not rel else (cx + n, cy + float(toks[i - 1]))
            # after first moveto, pairs become lineto
            if sub:
                pass
            else:
                sx, sy = cx, cy
            sub.append(pt(cx, cy))
            cmd = "l" if rel else "L"
        elif cmd in "Ll":
            rel = cmd == "l"
            x = (cx + n) if rel else n
            y = (cy + float(toks[i + 1])) if rel else float(toks[i + 1])
            i += 2
            cx, cy = x, y
            sub.append(pt(cx, cy))
        elif cmd in "Cc":
            rel = cmd == "c"
            pts = [float(toks[i + j]) for j in range(6)]
            i += 6
            if rel:
                x2, y2 = cx + pts[4], cy + pts[5]
            else:
                x2, y2 = pts[4], pts[5]
            # flatten curve: just take endpoint (good enough at icon size)
            cx, cy = x2, y2
            sub.append(pt(cx, cy))
        else:
            i += 1  # skip arcs/etc gracefully
    flush()
    for p in polys:
        if len(p) >= 3:
            draw.polygon(p, fill=fill)

def main():
    img = Image.new("RGB", (SIZE, SIZE), NAVY)
    d = ImageDraw.Draw(img)
    for path in parse_paths():
        try:
            draw_path(d, path, fill=(255, 255, 255))
        except Exception as e:
            print("skip path:", e)
    img.save(ROOT / "site" / "icon.png")
    img.resize((180, 180), Image.LANCZOS).save(ROOT / "site" / "icon-180.png")
    print("wrote site/icon.png + site/icon-180.png")

if __name__ == "__main__":
    main()
