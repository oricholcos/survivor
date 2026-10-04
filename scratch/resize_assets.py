# -*- coding: utf-8 -*-
"""P0-1 asset downscale: resize transparent PNG sprites so long edge hits target px.

Display size in game must stay identical; only texture size and code divisors change.
Overwrites files in place (originals recoverable from git history).
"""
import os
from PIL import Image

SPRITES_DIR = os.path.join(os.path.dirname(__file__), "..", "public", "assets", "sprites")

# filename -> target long edge (px)
TARGETS = {
    "enemy_runner.png": 256,
    "enemy_standard.png": 256,
    "enemy_tank.png": 256,
    "enemy_boss_1.png": 256,
    "turret_base.png": 128,
    "turret_cannon.png": 128,
    "proj_missile.png": 128,
    "proj_mortar.png": 128,
    "drop_repair.png": 64,
    "wall_segment.png": 128,
}

# Optional preprocessing to avoid halo: fill transparent pixels' RGB with nearby
# opaque color (alpha=0 pixels keep alpha=0 but get clean RGB before Lanczos).
def decontaminate(img: Image.Image) -> Image.Image:
    img = img.copy()
    px = img.load()
    w, h = img.size
    # collect opaque pixels for simple nearest-opaque fill via multiple passes
    from collections import deque
    visited = [[False] * w for _ in range(h)]
    q = deque()
    for y in range(h):
        for x in range(w):
            if px[x, y][3] > 0:
                q.append((x, y))
                visited[y][x] = True
    # BFS from opaque pixels into transparent ones, spreading RGB
    while q:
        x, y = q.popleft()
        r, g, b, a = px[x, y]
        for nx, ny in ((x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)):
            if 0 <= nx < w and 0 <= ny < h and not visited[ny][nx]:
                pr, pg, pb, pa = px[nx, ny]
                px[nx, ny] = (r, g, b, pa)  # keep alpha, adopt neighbor RGB
                visited[ny][nx] = True
                q.append((nx, ny))
    return img


def resize_file(name: str, target_long: int, decontaminate_first: bool = False):
    path = os.path.join(SPRITES_DIR, name)
    img = Image.open(path)
    orig_size = img.size
    orig_bytes = os.path.getsize(path)
    if decontaminate_first:
        img = decontaminate(img)
    w, h = img.size
    long_edge = max(w, h)
    scale = target_long / long_edge
    new_w = round(w * scale)
    new_h = round(h * scale)
    out = img.resize((new_w, new_h), Image.LANCZOS)
    if out.mode != "RGBA":
        out = out.convert("RGBA")
    out.save(path, optimize=True)
    new_bytes = os.path.getsize(path)
    print(f"{name}: {orig_size[0]}x{orig_size[1]} -> {new_w}x{new_h} | "
          f"{orig_bytes} -> {new_bytes} bytes ({orig_bytes/1024:.1f}KB -> {new_bytes/1024:.1f}KB)")
    return new_w, new_h


def main():
    decon = "--decontaminate" in __import__("sys").argv
    total_old = total_new = 0
    print(f"mode: {'decontaminate+LANCZOS' if decon else 'plain LANCZOS'}")
    for name, target in TARGETS.items():
        path = os.path.join(SPRITES_DIR, name)
        total_old += os.path.getsize(path)
        resize_file(name, target, decontaminate_first=decon)
        total_new += os.path.getsize(path)
    print(f"\nTOTAL (10 sprites): {total_old} -> {total_new} bytes "
          f"({total_old/1024/1024:.2f}MB -> {total_new/1024/1024:.2f}MB)")


if __name__ == "__main__":
    main()
