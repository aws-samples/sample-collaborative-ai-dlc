"""Draw one continuous Isobar atlas with a quiet hierarchical boundary mesh."""

import json
import math
import os
import sys
from PIL import Image, ImageDraw, ImageFont


def font(size):
    path = os.environ.get(
        "ISOBAR_FONT", "/usr/share/fonts/truetype/dejavu/DejaVuSansCondensed.ttf"
    )
    try:
        return ImageFont.truetype(path, size)
    except OSError as error:
        raise RuntimeError(f"Required Isobar condensed font is unavailable: {path}") from error


def rgb(value):
    return tuple((value >> shift) & 255 for shift in (16, 8, 0))


def render(source, destination):
    data = json.load(open(source, encoding="utf-8"))
    width, height = data["width"], data["height"]
    paper = rgb(data["palette"]["paper"])
    canvas = Image.new("RGB", (width, height), paper)
    draw = ImageDraw.Draw(canvas)
    # The obstruction mask measures the actual union of opaque glyphs/halos
    # and boundary strokes, rather than reporting reserved rectangle area.
    blocked = Image.new("L", (width, height), 0)
    mask = ImageDraw.Draw(blocked)
    map_rect = data["mapRect"]
    frame_box = (
        map_rect["x"], map_rect["y"],
        map_rect["x"] + map_rect["w"], map_rect["y"] + map_rect["h"],
    )
    for panel in data["panels"]:
        for leaf in panel["children"]:
            body = leaf["body"]
            if "heat" not in leaf:
                continue
            heat = leaf["heat"]
            image = Image.new("RGB", (heat["w"], heat["h"]))
            image.putdata([
                rgb(data["palette"]["rain" if wet else "radar"][level])
                for level, wet in zip(heat["level"], heat["wet"])
            ])
            image = image.resize(
                (math.ceil(body["w"] / 4), math.ceil(body["h"] / 4)),
                Image.Resampling.NEAREST,
            )
            canvas.paste(
                image.resize((body["w"], body["h"]), Image.Resampling.NEAREST),
                (body["x"], body["y"]),
            )

    def line(box, color, thickness):
        draw.rectangle(box, outline=color, width=thickness)
        mask.rectangle(box, outline=255, width=thickness)

    # One mesh, not nested cards: no fills, no insets, no reserved title strips.
    for panel in data["panels"]:
        for leaf in panel["children"]:
            r = leaf["rect"]
            line((r["x"], r["y"], r["x"] + r["w"], r["y"] + r["h"]), (223, 201, 178), 1)
    for panel in data["panels"]:
        r = panel["rect"]
        line((r["x"], r["y"], r["x"] + r["w"], r["y"] + r["h"]), (185, 157, 129), 2)
    line(frame_box, (163, 135, 107), 2)

    labels = []
    parent_face, leaf_face = font(35), font(31)
    ink = (64, 43, 25)

    def text(value, x, y, face, box, kind):
        if face.getlength(value) > box[2] - box[0] - 16:
            raise ValueError(f"Architectural label is wider than its ownership box: {value}")
        bbox = draw.textbbox((x, y), value, font=face, stroke_width=2)
        if bbox[0] < box[0] or bbox[2] > box[2] or bbox[3] > box[3]:
            raise ValueError(f"Architectural label crosses its ownership box: {value}")
        draw.text((x, y), value, font=face, fill=ink, stroke_width=2, stroke_fill=paper)
        mask.text((x, y), value, font=face, fill=255, stroke_width=2, stroke_fill=255)
        labels.append({"text": value, "kind": kind, "bbox": list(bbox), "position": [x, y]})

    for panel in data["panels"]:
        p = panel["rect"]
        box = (p["x"], p["y"], p["x"] + p["w"], p["y"] + p["h"])
        text(panel["name"], p["x"] + 8, p["y"] + 3, parent_face, box, "parent")
        for leaf in panel["children"]:
            r = leaf["rect"]
            bounds = (r["x"], r["y"], r["x"] + r["w"], r["y"] + r["h"])
            # Only the label moves below its parent's title, never its heat.
            ty = r["y"] + (43 if r["y"] == p["y"] else 5)
            text(leaf["name"], r["x"] + 8, ty, leaf_face, bounds, "leaf")

    # Every changed path has a stable eye. The letters resolve to evidence in
    # the same comment; shapes communicate status, colors communicate role.
    for panel in data["panels"]:
        for leaf in panel["children"]:
            for mark in leaf.get("markers", []):
                x, y = round(mark["x"]), round(mark["y"])
                color = (55, 91, 125) if mark["role"] == "test" else (
                    (99, 99, 99) if mark["role"] == "documentation" else (83, 34, 29))
                radius = 8
                box = (x-radius, y-radius, x+radius, y+radius)
                if mark["status"] == "added":
                    points = [(x,y-radius),(x+radius,y),(x,y+radius),(x-radius,y)]
                    draw.polygon(points, fill=paper, outline=color, width=3)
                    mask.polygon(points, fill=255)
                elif mark["status"] == "deleted":
                    draw.line((x-radius,y-radius,x+radius,y+radius), fill=color, width=4)
                    draw.line((x-radius,y+radius,x+radius,y-radius), fill=color, width=4)
                    mask.rectangle(box, fill=255)
                else:
                    draw.ellipse(box, fill=paper, outline=color, width=3)
                    mask.ellipse(box, fill=255)
    occupied_badges = []
    for panel in data["panels"]:
        for leaf in panel["children"]:
            r = leaf["rect"]
            for mark in leaf.get("markers", []):
                if not mark.get("key"):
                    continue
                x, y = round(mark["x"]), round(mark["y"])
                radius = 14
                candidates = [(x, y)]
                for distance in (28, 42, 56, 70, 84):
                    candidates.extend((x+dx*distance, y+dy*distance) for dx,dy in
                                      ((0,1),(1,0),(-1,0),(0,-1),(1,1),(-1,1),(1,-1),(-1,-1)))
                def fits(point):
                    cx,cy = point
                    b = (cx-radius,cy-radius,cx+radius,cy+radius)
                    if b[0] < r["x"] or b[1] < r["y"] or b[2] > r["x"]+r["w"] or b[3] > r["y"]+r["h"]:
                        return False
                    return not any(min(b[2],q[2])+2 > max(b[0],q[0]) and
                                   min(b[3],q[3])+2 > max(b[1],q[1])
                                   for q in [l["bbox"] for l in labels]+occupied_badges)
                placed = next((point for point in candidates if fits(point)), None)
                if placed is None:
                    raise ValueError(f"No legible annotation placement: {mark['path']}")
                cx,cy = placed
                color = (55,91,125) if mark["role"] == "test" else (
                    (99,99,99) if mark["role"] == "documentation" else (83,34,29))
                if placed != (x,y):
                    draw.line((x,y,cx,cy), fill=color, width=2)
                    mask.line((x,y,cx,cy), fill=255, width=2)
                box = (cx-radius,cy-radius,cx+radius,cy+radius)
                occupied_badges.append(box)
                mark["badge"] = {"x": cx, "y": cy, "bbox": list(box)}
                draw.ellipse(box, fill=color)
                mask.ellipse(box, fill=255)
                draw.text((cx,cy), mark["key"], font=font(22), fill=paper, anchor="mm")
    # Architecture remains readable even where a true file eye/leader crosses
    # a glyph. Badges themselves are placed only on open ground.
    for label in labels:
        draw.text(tuple(label["position"]), label["text"],
                  font=parent_face if label["kind"] == "parent" else leaf_face,
                  fill=ink, stroke_width=2, stroke_fill=paper)

    draw.text((12, 9), "ISOBAR · COLLABORATIVE AI-DLC", font=font(29), fill=(101, 77, 55))
    caption = data["caption"]
    caption_face = font(25)
    draw.text((width - caption_face.getlength(caption) - 12, 12), caption, font=caption_face, fill=(112, 88, 67))
    footer = height - 47
    draw.rectangle((12, footer + 5, 31, footer + 24), fill=rgb(data["palette"]["radar"][11]))
    draw.text((42, footer), "changed files · not a risk grade", font=font(26), fill=ink)
    draw.rectangle((475, footer + 5, 494, footer + 24), fill=rgb(data["palette"]["rain"][8]))
    draw.text((505, footer), "static reach: solid matched / dotted fallback", font=font(26), fill=ink)
    draw.text((1190, footer), "○ modified   ◇ new   × deleted · blue test / gray docs · A/B: comment", font=font(25), fill=(112, 88, 67))

    cropped = blocked.crop(frame_box)
    blocked_pixels = sum(cropped.histogram()[1:])
    map_area = map_rect["w"] * map_rect["h"]
    data["density"] = {
        "mapArea": map_area,
        "leafFieldArea": sum(l["body"]["w"] * l["body"]["h"] for p in data["panels"] for l in p["children"]),
        "opaqueObstructionUnionArea": blocked_pixels,
        "visibleHeatRatio": (map_area - blocked_pixels) / (width * height),
        "visibleHeatWithinFrame": (map_area - blocked_pixels) / map_area,
        "labelCount": len(labels),
        "opaquePlateArea": 0,
    }
    if data["density"]["leafFieldArea"] != map_area:
        raise ValueError("Leaf fields must cover the full atlas frame")
    if data["density"]["visibleHeatRatio"] < 0.85 or data["density"]["visibleHeatWithinFrame"] < 0.90:
        raise ValueError("Text or scaffolding obstructs too much of the atlas")
    data["labels"] = labels
    for index, a in enumerate(labels):
        for b in labels[index + 1:]:
            ax1, ay1, ax2, ay2 = a["bbox"]
            bx1, by1, bx2, by2 = b["bbox"]
            if min(ax2, bx2) > max(ax1, bx1) and min(ay2, by2) > max(ay1, by1):
                raise ValueError(f"Architectural labels overlap: {a['text']} / {b['text']}")
    with open(source, "w", encoding="utf-8") as output:
        json.dump(data, output)
    canvas.save(destination)
    print(f"{destination} ({width} × {height}), visible map {(map_area-blocked_pixels)/map_area:.1%}")


if __name__ == "__main__":
    render(sys.argv[1], sys.argv[2])
