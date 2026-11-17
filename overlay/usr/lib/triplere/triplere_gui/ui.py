"""Small immediate-mode widget toolkit drawn with Pillow.

Every frame a screen calls the widget functions of a Frame; each widget draws itself and
registers its rectangle (for the mouse) and its place in the focus order (for the keyboard).
"""

import os

from PIL import Image, ImageDraw, ImageFont

# Triple Re colours (logo green on white)
GREEN = (15, 133, 64)
GREEN_DARK = (10, 98, 47)
GREEN_LIGHT = (231, 244, 236)
BG = (243, 245, 244)
CARD = (255, 255, 255)
BORDER = (214, 220, 217)
TEXT = (28, 33, 31)
MUTED = (104, 114, 110)
RED = (198, 40, 40)
RED_DARK = (150, 25, 25)
RED_LIGHT = (253, 236, 236)
AMBER = (178, 106, 0)
AMBER_LIGHT = (255, 244, 222)
BLUE = (25, 103, 210)
FOCUS = (25, 103, 210)
WHITE = (255, 255, 255)
DISABLED = (190, 196, 193)

FONT_DIRS = ["/usr/share/fonts/dejavu", "/usr/share/fonts/truetype/dejavu", "/usr/share/fonts", "/usr/share/fonts/TTF",
             "/Library/Fonts", "/System/Library/Fonts/Supplemental"]
FONT_FILES = {
    "regular": ["DejaVuSans.ttf", "Arial.ttf"],
    "bold": ["DejaVuSans-Bold.ttf", "Arial Bold.ttf"],
}


def _find_font(kind):
    extra = os.environ.get("TRIPLERE_FONT_DIR")
    dirs = ([extra] if extra else []) + FONT_DIRS
    for d in dirs:
        for name in FONT_FILES[kind]:
            p = os.path.join(d, name)
            if os.path.isfile(p):
                return p
    return None


def trim_logo(img):
    """Crops the white margin around the logo so it can be shown larger."""
    if img is None:
        return None
    from PIL import ImageChops, ImageOps

    gray = ImageOps.invert(img.convert("L"))
    bbox = gray.point(lambda v: 255 if v > 24 else 0).getbbox()
    if not bbox:
        return img
    pad = 6
    return img.crop((max(0, bbox[0] - pad), max(0, bbox[1] - pad), min(img.width, bbox[2] + pad),
                     min(img.height, bbox[3] + pad)))


class Fonts:
    def __init__(self, scale):
        self.scale = scale
        self.paths = {k: _find_font(k) for k in FONT_FILES}
        self.cache = {}

    def get(self, size, bold=False):
        px = max(8, int(round(size * self.scale)))
        key = (px, bold)
        if key not in self.cache:
            path = self.paths["bold" if bold else "regular"] or self.paths["regular"]
            if path:
                self.cache[key] = ImageFont.truetype(path, px)
            else:
                self.cache[key] = ImageFont.load_default(px)
        return self.cache[key]


class Frame:
    """One frame being drawn. Coordinates are in design units (1280x720) and scaled."""

    def __init__(self, width, height, fonts, focus_id, hover_pos, logo=None):
        self.img = Image.new("RGB", (width, height), BG)
        self.d = ImageDraw.Draw(self.img)
        self.W = width
        self.H = height
        self.s = fonts.scale
        self.fonts = fonts
        self.focus_id = focus_id
        self.hover = hover_pos
        self.logo = logo
        self.zones = []  # (id, (x0,y0,x1,y1))
        self.order = []  # focusable ids in order
        self.text_fields = set()
        self.default_id = None

    # --- geometry -----------------------------------------------------
    def px(self, v):
        return int(round(v * self.s))

    def rect(self, x, y, w, h):
        return (self.px(x), self.px(y), self.px(x + w), self.px(y + h))

    @property
    def width_units(self):
        return self.W / self.s

    @property
    def height_units(self):
        return self.H / self.s

    def _hovered(self, r):
        if not self.hover:
            return False
        x, y = self.hover
        return r[0] <= x < r[2] and r[1] <= y < r[3]

    # --- drawing primitives -------------------------------------------
    def box(self, x, y, w, h, fill=CARD, outline=BORDER, radius=10, width=1):
        self.d.rounded_rectangle(self.rect(x, y, w, h), radius=self.px(radius), fill=fill,
                                 outline=outline, width=max(1, self.px(width)) if outline else 0)

    def text(self, x, y, s, size=18, bold=False, color=TEXT, anchor="la", max_w=None):
        font = self.fonts.get(size, bold)
        if max_w is not None:
            s = self.ellipsize(s, font, self.px(max_w))
        self.d.text((self.px(x), self.px(y)), s, font=font, fill=color, anchor=anchor)

    def text_width(self, s, size=18, bold=False):
        return self.d.textlength(s, font=self.fonts.get(size, bold)) / self.s

    def ellipsize(self, s, font, max_px):
        if self.d.textlength(s, font=font) <= max_px:
            return s
        while s and self.d.textlength(s + "...", font=font) > max_px:
            s = s[:-1]
        return s + "..."

    def wrap(self, x, y, s, w, size=18, bold=False, color=TEXT, line_gap=1.35):
        """Draws wrapped text; returns the y below the last line (design units)."""
        font = self.fonts.get(size, bold)
        max_px = self.px(w)
        for para in s.split("\n"):
            words = para.split(" ")
            line = ""
            for word in words:
                trial = (line + " " + word).strip()
                if self.d.textlength(trial, font=font) <= max_px or not line:
                    line = trial
                else:
                    self.text(x, y, line, size, bold, color)
                    y += size * line_gap
                    line = word
            self.text(x, y, line, size, bold, color)
            y += size * line_gap
        return y

    def logo_at(self, x, y, h):
        if self.logo is None:
            return 0
        hp = self.px(h)
        wp = int(self.logo.width * hp / self.logo.height)
        img = self.logo.resize((wp, hp), Image.LANCZOS)
        self.img.paste(img, (self.px(x), self.px(y)))
        return wp / self.s

    # --- widgets ------------------------------------------------------
    def _register(self, wid, r, focusable=True):
        self.zones.append((wid, r))
        if focusable:
            self.order.append(wid)

    def button(self, wid, x, y, w, h, label, kind="primary", enabled=True, size=19, default=False):
        r = self.rect(x, y, w, h)
        focused = self.focus_id == wid
        hovered = enabled and self._hovered(r)
        if kind == "primary":
            fill, fg, outline = (GREEN_DARK if hovered else GREEN), WHITE, None
        elif kind == "danger":
            fill, fg, outline = (RED_DARK if hovered else RED), WHITE, None
        else:
            fill, fg, outline = (GREEN_LIGHT if hovered else CARD), TEXT, BORDER
        if not enabled:
            fill, fg, outline = (236, 238, 237), DISABLED, BORDER
        self.d.rounded_rectangle(r, radius=self.px(10), fill=fill, outline=outline,
                                 width=max(1, self.px(1.5)) if outline else 0)
        if focused:
            g = self.px(4)
            self.d.rounded_rectangle((r[0] - g, r[1] - g, r[2] + g, r[3] + g), radius=self.px(13),
                                     outline=FOCUS, width=max(2, self.px(3)))
        self.text(x + w / 2, y + h / 2, label, size, True, fg, anchor="mm", max_w=w - 16)
        if enabled:
            self._register(wid, r)
            if default:
                self.default_id = wid

    def checkbox_row(self, wid, x, y, w, h, checked, draw_body, enabled=True):
        """A selectable card row. draw_body(x, y, w, h) draws the contents."""
        r = self.rect(x, y, w, h)
        focused = self.focus_id == wid
        hovered = enabled and self._hovered(r)
        fill = GREEN_LIGHT if (checked and enabled) else (CARD if not hovered else (248, 250, 249))
        outline = GREEN if (checked and enabled) else BORDER
        self.d.rounded_rectangle(r, radius=self.px(10), fill=fill, outline=outline, width=max(1, self.px(2)))
        if focused:
            g = self.px(4)
            self.d.rounded_rectangle((r[0] - g, r[1] - g, r[2] + g, r[3] + g), radius=self.px(13),
                                     outline=FOCUS, width=max(2, self.px(3)))
        # the tick box
        bs = 28
        bx, by = x + 18, y + (h - bs) / 2
        self.d.rounded_rectangle(self.rect(bx, by, bs, bs), radius=self.px(6),
                                 fill=GREEN if checked else WHITE,
                                 outline=GREEN if checked else (150, 158, 154), width=max(1, self.px(2)))
        if checked:
            pts = [(bx + 6, by + 14), (bx + 12, by + 20), (bx + 22, by + 8)]
            self.d.line([(self.px(a), self.px(b)) for a, b in pts], fill=WHITE, width=max(2, self.px(3.5)), joint="curve")
        draw_body(x + 62, y, w - 62, h)
        if enabled:
            self._register(wid, r)

    def list_row(self, wid, x, y, w, h, draw_body, selected=False):
        r = self.rect(x, y, w, h)
        focused = self.focus_id == wid
        hovered = self._hovered(r)
        fill = GREEN_LIGHT if (selected or hovered) else CARD
        self.d.rounded_rectangle(r, radius=self.px(10), fill=fill, outline=GREEN if selected else BORDER,
                                 width=max(1, self.px(1.5)))
        if focused:
            g = self.px(4)
            self.d.rounded_rectangle((r[0] - g, r[1] - g, r[2] + g, r[3] + g), radius=self.px(13),
                                     outline=FOCUS, width=max(2, self.px(3)))
        draw_body(x, y, w, h)
        self._register(wid, r)

    def text_field(self, wid, x, y, w, h, value, placeholder="", secret=False, size=20):
        r = self.rect(x, y, w, h)
        focused = self.focus_id == wid
        self.d.rounded_rectangle(r, radius=self.px(8), fill=WHITE, outline=FOCUS if focused else BORDER,
                                 width=max(2, self.px(3 if focused else 1.5)))
        shown = ("•" * len(value)) if secret else value
        font = self.fonts.get(size)
        max_px = self.px(w - 28)
        while shown and self.d.textlength(shown, font=font) > max_px:
            shown = shown[1:]
        if value:
            self.text(x + 14, y + h / 2, shown, size, False, TEXT, anchor="lm")
        elif placeholder:
            self.text(x + 14, y + h / 2, placeholder, size, False, MUTED, anchor="lm")
        if focused:
            cx = x + 14 + (self.d.textlength(shown, font=font) / self.s if value else 0) + 2
            self.d.line([(self.px(cx), self.px(y + 10)), (self.px(cx), self.px(y + h - 10))], fill=TEXT,
                        width=max(1, self.px(2)))
        self._register(wid, r)
        self.text_fields.add(wid)

    def progress(self, x, y, w, h, fraction, color=GREEN, indeterminate_phase=None):
        self.d.rounded_rectangle(self.rect(x, y, w, h), radius=self.px(h / 2), fill=(225, 230, 227))
        if indeterminate_phase is not None:
            seg = w * 0.25
            start = (w + seg) * indeterminate_phase - seg
            a, b = max(0, start), min(w, start + seg)
            if b > a:
                self.d.rounded_rectangle(self.rect(x + a, y, b - a, h), radius=self.px(h / 2), fill=color)
            return
        f = max(0.0, min(1.0, fraction))
        if f > 0:
            self.d.rounded_rectangle(self.rect(x, y, max(h, w * f), h), radius=self.px(h / 2), fill=color)

    def spinner(self, cx, cy, r, phase, color=GREEN):
        start = int(phase * 360)
        self.d.arc(self.rect(cx - r, cy - r, 2 * r, 2 * r), start, start + 270, fill=color, width=max(3, self.px(5)))

    def icon_check(self, cx, cy, r, color=GREEN):
        self.d.ellipse(self.rect(cx - r, cy - r, 2 * r, 2 * r), fill=color)
        pts = [(cx - r * 0.45, cy), (cx - r * 0.1, cy + r * 0.35), (cx + r * 0.5, cy - r * 0.35)]
        self.d.line([(self.px(a), self.px(b)) for a, b in pts], fill=WHITE, width=max(2, self.px(r * 0.2)), joint="curve")

    def icon_cross(self, cx, cy, r, color=RED):
        self.d.ellipse(self.rect(cx - r, cy - r, 2 * r, 2 * r), fill=color)
        k = r * 0.38
        w = max(2, self.px(r * 0.2))
        self.d.line([(self.px(cx - k), self.px(cy - k)), (self.px(cx + k), self.px(cy + k))], fill=WHITE, width=w)
        self.d.line([(self.px(cx - k), self.px(cy + k)), (self.px(cx + k), self.px(cy - k))], fill=WHITE, width=w)

    def icon_warn(self, cx, cy, r, color=AMBER):
        pts = [(cx, cy - r), (cx + r, cy + r * 0.85), (cx - r, cy + r * 0.85)]
        self.d.polygon([(self.px(a), self.px(b)) for a, b in pts], fill=color)
        self.text(cx, cy + r * 0.1, "!", r * 1.2, True, WHITE, anchor="mm")

    def wifi_bars(self, x, y, level, size=22):
        """level 0..4"""
        bw = size / 5
        for i in range(4):
            bh = size * (i + 1) / 4
            col = TEXT if i < level else (200, 205, 202)
            self.d.rectangle(self.rect(x + i * (bw + 2), y + size - bh, bw, bh), fill=col)
