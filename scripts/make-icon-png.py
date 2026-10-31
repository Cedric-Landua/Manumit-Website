"""Render PNG logo variants from site/favicon.svg.

Run from Website/: python scripts/make-icon-png.py
"""
import re
import xml.etree.ElementTree as ET
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
SVG = ROOT / "site" / "favicon.svg"
SIZES = (512, 180)
SCALE = 4
SVG_NS = "{http://www.w3.org/2000/svg}"


def render(size):
    root = ET.parse(SVG).getroot()
    view_width, view_height = map(float, root.attrib["viewBox"].split()[2:])
    canvas = Image.new("RGBA", (size * SCALE, size * SCALE), (0, 0, 0, 0))
    draw = ImageDraw.Draw(canvas)

    background = root.find(f"{SVG_NS}path")
    canvas_size = size * SCALE
    draw.rounded_rectangle(
        (0, 0, canvas_size - 1, canvas_size - 1),
        radius=canvas_size * 0.25,
        fill=background.attrib["fill"],
    )

    path = root.findall(f"{SVG_NS}path")[1]
    coordinates = [float(value) for value in re.findall(r"[-+]?\d*\.?\d+", path.attrib["d"])]
    points = [
        (coordinates[index] * size / view_width * SCALE, coordinates[index + 1] * size / view_height * SCALE)
        for index in range(0, len(coordinates), 2)
    ]
    stroke_width = float(path.attrib["stroke-width"]) * size / view_width * SCALE
    draw.line(points, fill=path.attrib["stroke"], width=round(stroke_width), joint="curve")
    radius = stroke_width / 2
    for x, y in (points[0], points[-1]):
        draw.ellipse((x - radius, y - radius, x + radius, y + radius), fill=path.attrib["stroke"])

    return canvas.resize((size, size), Image.Resampling.LANCZOS)


def main():
    for size, name in zip(SIZES, ("icon.png", "icon-180.png")):
        render(size).save(ROOT / "site" / name, format="PNG", optimize=True)
    print("wrote site/icon.png + site/icon-180.png")


if __name__ == "__main__":
    main()
