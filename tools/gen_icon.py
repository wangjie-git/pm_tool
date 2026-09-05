# 生成应用图标 1024x1024 PNG：渐变圆角方块 + 白色对勾（纯标准库）
import zlib, struct, math, random

SIZE = 1024
RADIUS = 230
C1 = (76, 110, 245)    # #4C6EF5
C2 = (21, 170, 191)    # #15AABF

CHECK = [(295, 545), (455, 710), (740, 365)]
CHECK_R = 47.0

def clamp(v, lo, hi):
    return lo if v < lo else (hi if v > hi else v)

def seg_dist(px, py, ax, ay, bx, by):
    vx, vy = bx - ax, by - ay
    wx, wy = px - ax, py - ay
    L2 = vx * vx + vy * vy
    if L2 == 0:
        return math.hypot(wx, wy)
    t = clamp((wx * vx + wy * vy) / L2, 0.0, 1.0)
    return math.hypot(px - (ax + t * vx), py - (ay + t * vy))

rows = []
half = SIZE / 2.0
inner = half - RADIUS

for y in range(SIZE):
    row = bytearray()
    ty = y / (SIZE - 1)
    for x in range(SIZE):
        # 圆角矩形 SDF
        qx = abs(x + 0.5 - half) - inner
        qy = abs(y + 0.5 - half) - inner
        outx, outy = max(qx, 0.0), max(qy, 0.0)
        d_rect = math.hypot(outx, outy) + min(max(qx, qy), 0.0) - RADIUS
        cov = clamp(0.5 - d_rect, 0.0, 1.0)
        if cov <= 0:
            row += b"\x00\x00\x00\x00"
            continue
        # 渐变底色
        t = clamp((y / SIZE) * 0.9 + (x / SIZE) * 0.1, 0.0, 1.0)
        r = C1[0] + (C2[0] - C1[0]) * t
        g = C1[1] + (C2[1] - C1[1]) * t
        b = C1[2] + (C2[2] - C1[2]) * t
        # 对勾
        d1 = seg_dist(x + 0.5, y + 0.5, *CHECK[0], *CHECK[1])
        d2 = seg_dist(x + 0.5, y + 0.5, *CHECK[1], *CHECK[2])
        d = min(d1, d2)
        a_chk = clamp(CHECK_R - d + 0.5, 0.0, 1.0)
        if a_chk > 0:
            r = r * (1 - a_chk) + 255 * a_chk
            g = g * (1 - a_chk) + 255 * a_chk
            b = b * (1 - a_chk) + 255 * a_chk
        row += bytes((int(r), int(g), int(b), int(cov * 255)))
    rows.append(bytes(row))

def png_chunk(tag, data):
    c = struct.pack(">I", len(data)) + tag + data
    return c + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

sig = b"\x89PNG\r\n\x1a\n"
ihdr = png_chunk(b"IHDR", struct.pack(">IIBBBBB", SIZE, SIZE, 8, 6, 0, 0, 0))
raw = b"".join(b"\x00" + r for r in rows)
idat = png_chunk(b"IDAT", zlib.compress(raw, 9))
iend = png_chunk(b"IEND", b"")

out = r"D:\ai\pm-todo\app-icon.png"
with open(out, "wb") as f:
    f.write(sig + ihdr + idat + iend)
print("written", out)
