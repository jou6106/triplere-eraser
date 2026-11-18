"""Screen output for the Triple Re graphical screens.

FramebufferDisplay draws straight to /dev/fb0 (the kernel's KMS/EFI/VESA framebuffer),
so the image needs no X server, Wayland or Mesa. ImageDisplay renders to PNG files and is
used by the tests.
"""

import fcntl
import mmap
import os
import struct
import sys

from PIL import Image

FBIOGET_VSCREENINFO = 0x4600
FBIOGET_FSCREENINFO = 0x4602
KDSETMODE = 0x4B3A
KD_TEXT = 0
KD_GRAPHICS = 1

CURSOR_SHAPE = [
    "X...........",
    "XX..........",
    "XOX.........",
    "XOOX........",
    "XOOOX.......",
    "XOOOOX......",
    "XOOOOOX.....",
    "XOOOOOOX....",
    "XOOOOOOOX...",
    "XOOOOOOOOX..",
    "XOOOOOOOOOX.",
    "XOOOOOOXXXXX",
    "XOOOXOOX....",
    "XOOXXOOX....",
    "XOX..XOOX...",
    "XX...XOOX...",
    "X.....XOOX..",
    "......XOOX..",
    ".......XX...",
]


def make_cursor(scale):
    """Arrow cursor as an RGBA image."""
    h = len(CURSOR_SHAPE)
    w = len(CURSOR_SHAPE[0])
    img = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    px = img.load()
    for y, row in enumerate(CURSOR_SHAPE):
        for x, ch in enumerate(row):
            if ch == "X":
                px[x, y] = (20, 20, 20, 255)
            elif ch == "O":
                px[x, y] = (255, 255, 255, 255)
    s = max(1, round(scale))
    if s > 1:
        img = img.resize((w * s, h * s), Image.NEAREST)
    return img


class BaseDisplay:
    width = 0
    height = 0

    def __init__(self):
        self.base = None
        self.cursor_img = None
        self.cursor_pos = None  # (x, y) when visible

    def set_cursor_image(self, img):
        self.cursor_img = img

    # -- to be provided by subclasses
    def _write_region(self, x0, y0, x1, y1):
        raise NotImplementedError

    def present(self, image):
        """Shows a full frame (an RGB image of width x height)."""
        self.base = image
        if self.cursor_pos and self.cursor_img:
            self._write_with_cursor(0, 0, self.width, self.height)
        else:
            self._write_region(0, 0, self.width, self.height)

    def move_cursor(self, pos):
        """Moves (or hides, pos=None) the pointer without redrawing the whole frame."""
        if self.base is None or pos == self.cursor_pos:
            self.cursor_pos = pos
            return
        old = self.cursor_pos
        self.cursor_pos = pos
        for p in (old, pos):
            if p and self.cursor_img:
                x0, y0 = p
                self._write_with_cursor(x0, y0, x0 + self.cursor_img.width, y0 + self.cursor_img.height)

    def _clip(self, x0, y0, x1, y1):
        return max(0, x0), max(0, y0), min(self.width, x1), min(self.height, y1)

    def _region_image(self, x0, y0, x1, y1):
        region = self.base.crop((x0, y0, x1, y1))
        if self.cursor_pos and self.cursor_img:
            cx, cy = self.cursor_pos
            region.paste(self.cursor_img, (cx - x0, cy - y0), self.cursor_img)
        return region

    def _write_with_cursor(self, x0, y0, x1, y1):
        x0, y0, x1, y1 = self._clip(x0, y0, x1, y1)
        if x1 > x0 and y1 > y0:
            self._write_image(x0, y0, self._region_image(x0, y0, x1, y1))

    def _write_image(self, x0, y0, img):
        raise NotImplementedError

    def close(self):
        pass


class FramebufferDisplay(BaseDisplay):
    def __init__(self, path="/dev/fb0", tty_path=None):
        super().__init__()
        self.fd = os.open(path, os.O_RDWR)
        try:
            v = fcntl.ioctl(self.fd, FBIOGET_VSCREENINFO, bytes(160))
            f = fcntl.ioctl(self.fd, FBIOGET_FSCREENINFO, bytes(80))
        except OSError:
            os.close(self.fd)
            raise
        (self.width, self.height, _xv, yres_virtual, self.xoff, self.yoff, bpp, _gray) = struct.unpack_from("8I", v, 0)
        red_off = struct.unpack_from("I", v, 32)[0]
        blue_off = struct.unpack_from("I", v, 56)[0]
        smem_len = struct.unpack_from("I", f, 24)[0]
        self.stride = struct.unpack_from("I", f, 48)[0]
        self.bpp = bpp
        if bpp == 32:
            self.rawmode = "BGRX" if red_off == 16 and blue_off == 0 else "RGBX"
        elif bpp == 24:
            self.rawmode = "BGR" if red_off == 16 else "RGB"
        elif bpp == 16:
            self.rawmode = "BGR;16"
        else:
            os.close(self.fd)
            raise RuntimeError(f"unsupported framebuffer depth: {bpp} bpp")
        self.bytespp = bpp // 8
        if self.width < 640 or self.height < 400 or self.stride < self.width * self.bytespp:
            os.close(self.fd)
            raise RuntimeError(f"framebuffer too small: {self.width}x{self.height}")
        size = smem_len or self.stride * yres_virtual
        self.mem = mmap.mmap(self.fd, size, mmap.MAP_SHARED, mmap.PROT_READ | mmap.PROT_WRITE)
        self.origin = self.yoff * self.stride + self.xoff * self.bytespp
        if self.origin + self.stride * (self.height - 1) + self.width * self.bytespp > size:
            self.close()
            raise RuntimeError("framebuffer geometry does not fit its memory")
        # Pixels go in with write(), not through the mmap. KMS drivers (i915, amdgpu,
        # nouveau...) only refresh the screen for written ranges: a laptop panel with
        # self-refresh (PSR) keeps showing the old picture when the memory is changed
        # behind the driver's back. The mmap stays as a fallback if write() is refused.
        self.use_write = True
        self.fb_name = f[:16].split(b"\0", 1)[0].decode("ascii", "replace")
        sys.stderr.write(
            f"framebuffer {path}: {self.fb_name!r} {self.width}x{self.height} {bpp}bpp "
            f"stride {self.stride} offset {self.xoff},{self.yoff} mem {size}\n"
        )
        sys.stderr.flush()

        # Stop the text console from drawing over the picture (restored in close()).
        self.tty_fd = None
        for candidate in (tty_path, "/dev/tty0"):
            if not candidate:
                continue
            try:
                self.tty_fd = os.open(candidate, os.O_RDWR | os.O_NOCTTY)
                os.write(self.tty_fd, b"\033[9;0]\033[?25l")  # no screen blanking, hide cursor
                fcntl.ioctl(self.tty_fd, KDSETMODE, KD_GRAPHICS)
                break
            except OSError:
                if self.tty_fd is not None:
                    os.close(self.tty_fd)
                self.tty_fd = None

    def _write_region(self, x0, y0, x1, y1):
        self._write_image(x0, y0, self.base.crop((x0, y0, x1, y1)) if (x0, y0, x1, y1) != (0, 0, self.width, self.height) else self.base)

    def _write_image(self, x0, y0, img):
        data = img.tobytes("raw", self.rawmode)
        row = img.width * self.bytespp
        start = self.origin + y0 * self.stride + x0 * self.bytespp
        if self.use_write:
            try:
                self._pwrite_rows(data, row, start, img.height)
                return
            except OSError as e:
                self.use_write = False
                sys.stderr.write(f"framebuffer write() refused ({e}); drawing through mmap\n")
                sys.stderr.flush()
        if x0 == 0 and img.width == self.width and row == self.stride:
            self.mem[start:start + len(data)] = data
            return
        for y in range(img.height):
            off = start + y * self.stride
            self.mem[off:off + row] = data[y * row:(y + 1) * row]

    def _pwrite_rows(self, data, row, start, rows):
        view = memoryview(data)
        if row == self.stride:
            chunks = [(start, view)]
        else:
            chunks = [(start + y * self.stride, view[y * row:(y + 1) * row]) for y in range(rows)]
        for off, chunk in chunks:
            while len(chunk):
                n = os.pwrite(self.fd, chunk, off)
                if n <= 0:
                    raise OSError("short write to the framebuffer")
                chunk = chunk[n:]
                off += n

    def close(self):
        if self.tty_fd is not None:
            try:
                fcntl.ioctl(self.tty_fd, KDSETMODE, KD_TEXT)
                os.write(self.tty_fd, b"\033[?25h")
            except OSError:
                pass
            os.close(self.tty_fd)
            self.tty_fd = None
        try:
            self.mem.close()
        except Exception:
            pass
        try:
            os.close(self.fd)
        except OSError:
            pass


class ImageDisplay(BaseDisplay):
    """Off-screen display for tests: keeps the last frame (with cursor) as an image."""

    def __init__(self, width=1280, height=720):
        super().__init__()
        self.width = width
        self.height = height
        self.frame = Image.new("RGB", (width, height))
        self.frames = 0

    def _write_region(self, x0, y0, x1, y1):
        self._write_image(x0, y0, self.base.crop((x0, y0, x1, y1)))

    def _write_image(self, x0, y0, img):
        self.frame.paste(img, (x0, y0))
        self.frames += 1

    def save(self, path):
        self.frame.save(path)
