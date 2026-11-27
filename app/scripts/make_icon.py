"""Draws the app icon (a node graph: two boxes and a wire) as a 1024x1024 PNG, with only the
standard library. `npx tauri icon src-tauri/icons/app-icon.png` makes every size from it."""
import os, struct, zlib
N = 1024
BG, BOX, HEAD, WIRE, PIN = (29, 31, 35), (43, 46, 53), (36, 113, 163), (240, 240, 240), (26, 188, 156)
px = [[BG] * N for _ in range(N)]
def rect(x0, y0, x1, y1, c):
    for y in range(y0, y1):
        row = px[y]
        for x in range(x0, x1):
            row[x] = c
def disc(cx, cy, r, c):
    for y in range(cy - r, cy + r + 1):
        for x in range(cx - r, cx + r + 1):
            if (x - cx) ** 2 + (y - cy) ** 2 <= r * r:
                px[y][x] = c
# rounded background square
r = 180
for y in range(N):
    for x in range(N):
        dx = max(r - x, 0, x - (N - 1 - r)); dy = max(r - y, 0, y - (N - 1 - r))
        if dx * dx + dy * dy > r * r:
            px[y][x] = (0, 0, 0, 0)
# two nodes
rect(130, 250, 470, 560, BOX); rect(130, 250, 470, 330, HEAD)
rect(554, 470, 894, 780, BOX); rect(554, 470, 894, 550, (169, 50, 38))
# a wire from the left node's output to the right node's input (a smooth S curve)
for t in range(0, 2001):
    t /= 2000
    x0, y0, x1, y1 = 470, 445, 554, 665
    x = (1 - t) ** 3 * x0 + 3 * (1 - t) ** 2 * t * (x0 + 140) + 3 * (1 - t) * t ** 2 * (x1 - 140) + t ** 3 * x1
    y = (1 - t) ** 3 * y0 + 3 * (1 - t) ** 2 * t * y0 + 3 * (1 - t) * t ** 2 * y1 + t ** 3 * y1
    disc(int(x), int(y), 14, WIRE)
disc(470, 445, 30, PIN); disc(554, 665, 30, PIN)
raw = b"".join(b"\x00" + b"".join(bytes(c if len(c) == 4 else (*c, 255)) for c in row) for row in px)
def chunk(t, d):
    return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)
png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", N, N, 8, 6, 0, 0, 0)) + \
      chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")
out = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "src-tauri", "icons", "app-icon.png")
open(out, "wb").write(png)
print("wrote", out)
