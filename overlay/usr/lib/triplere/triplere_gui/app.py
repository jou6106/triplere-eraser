"""Triple Re Eraser graphical screens.

Flow: network -> licence -> job details -> disks -> confirm -> progress -> reports
(-> disks again for the next batch). The technician can use a mouse, a touchpad, a
touchscreen or only the keyboard (Tab/arrows, Enter, Space).

Exit codes: EXIT_CLASSIC = the technician asked for the classic text screen.
"""

import queue
import threading
import time

from . import ui
from .display import make_cursor
from .inputdev import Key, Pointer
from .system import METHODS, human_size

EXIT_CLASSIC = 3
DESIGN_W, DESIGN_H = 1280, 720
HEADER_H = 76
FOOTER_H = 40


class App:
    def __init__(self, display, inputs, system, logo=None, clock=time.monotonic):
        self.display = display
        self.inputs = inputs
        self.sys = system
        self.logo = ui.trim_logo(logo)
        self.clock = clock
        self.scale = min(display.width / DESIGN_W, display.height / DESIGN_H)
        self.fonts = ui.Fonts(self.scale)
        self.focus = None
        self.zones = []
        self.order = []
        self.text_fields = set()
        self.default_id = None
        self.screen = None
        self.exit_code = None
        self.dirty = True
        self.hover_zone = None
        self.results = queue.Queue()
        self.net = {"online": False, "wifi": False, "ssid": "", "wired": False}
        self.job = {"client_name": "", "technician_name": "", "work_order": ""}
        self.job_asked = False
        self.last_render = 0.0
        self.cursor = None
        display.set_cursor_image(make_cursor(self.scale))

    # ---------------------------------------------------------------- plumbing
    def bg(self, fn, done):
        """Runs fn() in a thread; done(result) is then called on the main loop."""

        def worker():
            try:
                r = fn()
            except Exception as e:  # reported to the screen, never kills the GUI
                r = e
            self.results.put((done, r))

        threading.Thread(target=worker, daemon=True).start()

    def goto(self, screen):
        self.screen = screen
        self.focus = None
        self.dirty = True
        screen.enter()

    def redraw(self):
        self.dirty = True

    def render(self):
        hover = tuple(self.cursor) if self.cursor else None
        f = ui.Frame(self.display.width, self.display.height, self.fonts, self.focus, hover, self.logo)
        self._header(f)
        self.screen.draw(f)
        self._footer(f)
        self.zones, self.order, self.text_fields, self.default_id = f.zones, f.order, f.text_fields, f.default_id
        if self.order and self.focus not in self.order:
            want = getattr(self.screen, "initial_focus", None)
            self.focus = want if want in self.order else (self.default_id or self.order[0])
            return self.render()
        self.display.present(f.img)
        self.dirty = False
        self.last_render = self.clock()

    def _header(self, f):
        W = f.width_units
        f.d.rectangle((0, 0, f.W, f.px(HEADER_H)), fill=ui.WHITE)
        f.d.line((0, f.px(HEADER_H), f.W, f.px(HEADER_H)), fill=ui.BORDER, width=max(1, f.px(1)))
        lw = f.logo_at(24, 20, 36)
        f.text(24 + lw + 16, 22, "Triple Re Eraser", 26, True, ui.TEXT)
        f.text(24 + lw + 16 + f.text_width("Triple Re Eraser", 26, True) + 14, 30, "Certified data erasure", 15,
               False, ui.MUTED)
        # network pill
        n = self.net
        if n.get("online"):
            label = "Online - " + ("Wi-Fi " + n["ssid"] if n.get("ssid") else "cable")
            col, bg = ui.GREEN, ui.GREEN_LIGHT
        else:
            label, col, bg = "Offline - reports saved on USB", ui.AMBER, ui.AMBER_LIGHT
        tw = min(f.text_width(label, 15, True), 330)
        x = W - 24 - tw - 40
        f.box(x, 22, tw + 40, 32, fill=bg, outline=None, radius=16)
        f.d.ellipse(f.rect(x + 13, 33, 10, 10), fill=col)
        f.text(x + 30, 38, label, 15, True, col, anchor="lm", max_w=330)

    def _footer(self, f):
        y = f.height_units - FOOTER_H
        f.d.rectangle((0, f.px(y), f.W, f.H), fill=(232, 236, 234))
        hint = getattr(self.screen, "hint", None) or \
            "Mouse or touchpad: click.   Keyboard: Tab / arrows to move,  Enter to choose,  Space to tick."
        f.text(24, y + FOOTER_H / 2, hint, 15, False, ui.MUTED, anchor="lm")

    # ---------------------------------------------------------------- input
    def activate(self, wid):
        self.dirty = True
        self.screen.on_action(wid)

    def handle(self, ev):
        if isinstance(ev, Pointer):
            if ev.kind == "move":
                self.cursor = (ev.x, ev.y)
                self.display.move_cursor(self.cursor)
                z = self._zone_at(ev.x, ev.y)
                if z != self.hover_zone:
                    self.hover_zone = z
                    self.dirty = True
            elif ev.kind == "click":
                self.cursor = (ev.x, ev.y)
                self.display.move_cursor(self.cursor)
                z = self._zone_at(ev.x, ev.y)
                if z:
                    self.focus = z
                    if z in self.text_fields:
                        self.dirty = True
                    else:
                        self.activate(z)
            elif ev.kind == "scroll":
                if hasattr(self.screen, "on_scroll"):
                    self.screen.on_scroll(-ev.delta)
                    self.dirty = True
            return
        if not isinstance(ev, Key):
            return
        self.dirty = True
        in_text = self.focus in self.text_fields
        if in_text and ev.name == "char" and not ev.ctrl:
            self.screen.on_text(self.focus, ev.char)
            return
        if in_text and ev.name == "backspace":
            self.screen.on_backspace(self.focus)
            return
        if ev.name == "enter":
            if in_text and hasattr(self.screen, "on_enter"):
                self.screen.on_enter(self.focus)
            elif self.focus in self.order:
                self.activate(self.focus)
            elif self.default_id:
                self.activate(self.default_id)
            return
        if ev.name == "char" and ev.char == " ":
            if self.focus in self.order:
                self.activate(self.focus)
            return
        if ev.name == "esc":
            if hasattr(self.screen, "on_back"):
                self.screen.on_back()
            return
        step = 0
        if ev.name in ("tab",):
            step = -1 if ev.shift else 1
        elif ev.name in ("down", "right") and not (in_text and ev.name == "right"):
            step = 1
        elif ev.name in ("up", "left") and not (in_text and ev.name == "left"):
            step = -1
        elif ev.name in ("pagedown", "pageup") and hasattr(self.screen, "on_scroll"):
            self.screen.on_scroll(5 if ev.name == "pagedown" else -5)
        if step and hasattr(self.screen, "on_nav") and self.screen.on_nav(self.focus, step):
            return
        if step and self.order:
            i = self.order.index(self.focus) if self.focus in self.order else -1
            i = (i + step) % len(self.order)
            self.focus = self.order[i]
            if hasattr(self.screen, "on_focus"):
                self.screen.on_focus(self.focus)

    def _zone_at(self, x, y):
        for wid, r in reversed(self.zones):
            if r[0] <= x < r[2] and r[1] <= y < r[3]:
                return wid
        return None

    # ---------------------------------------------------------------- main loop
    def step(self, timeout=0.1):
        for ev in self.inputs.poll(timeout):
            self.handle(ev)
        while True:
            try:
                done, r = self.results.get_nowait()
            except queue.Empty:
                break
            done(r)
            self.dirty = True
        now = self.clock()
        if self.screen.tick(now):
            self.dirty = True
        if self.dirty or now - self.last_render > 1.0:
            self.render()

    def run(self, first_screen=None):
        self.goto(first_screen or NetworkScreen(self))
        while self.exit_code is None:
            self.step()
        return self.exit_code


# ==================================================================== screens
class Screen:
    hint = None
    initial_focus = None

    def __init__(self, app):
        self.app = app
        self.t0 = app.clock()

    def enter(self):
        pass

    def tick(self, now):
        return False

    def on_action(self, wid):
        pass

    def on_text(self, wid, ch):
        pass

    def on_backspace(self, wid):
        pass

    # helpers
    def content(self, f):
        """(x, y, w, h) of the area between header and footer, in design units."""
        return 0, HEADER_H, f.width_units, f.height_units - HEADER_H - FOOTER_H

    def phase(self):
        return (self.app.clock() - self.t0) % 1.0

    def title(self, f, x, y, text, sub=None):
        f.text(x, y, text, 30, True, ui.TEXT)
        if sub:
            return f.wrap(x, y + 46, sub, f.width_units - 2 * x, 18, False, ui.MUTED)
        return y + 46

    def center_card(self, f, w, h):
        cx, cy, cw, ch = self.content(f)
        x = (cw - w) / 2
        y = cy + max(16, (ch - h) / 2)
        f.box(x, y, w, h, radius=16)
        return x, y


class BusyMixin:
    """A centred card with a spinner and a message."""

    def draw_busy(self, f, title, message):
        x, y = self.center_card(f, 640, 230)
        f.spinner(x + 320, y + 70, 28, self.phase())
        f.text(x + 320, y + 135, title, 24, True, ui.TEXT, anchor="mm")
        f.text(x + 320, y + 175, message, 17, False, ui.MUTED, anchor="mm", max_w=600)

    def tick(self, now):
        return getattr(self, "busy", False)


# -------------------------------------------------------------------- network
class NetworkScreen(BusyMixin, Screen):
    AUTO_OFFLINE = 30

    def enter(self):
        self.busy = True
        self.state = "checking"
        self.msg = "Checking the network..."
        self.until = None
        self.app.bg(self._check, self._checked)

    def _check(self):
        s = self.app.sys
        st = s.net_status()
        if st["online"]:
            s.sync_clock()
            return st
        if st["wifi"] and s.has_saved_wifi():
            self.msg = "Connecting to the saved Wi-Fi network..."
            if s.net_connect_saved():
                s.sync_clock()
                return s.net_status()
        return st

    def _checked(self, st):
        self.busy = False
        if isinstance(st, Exception):
            st = {"online": False, "wifi": False, "ssid": "", "wired": False}
        self.app.net = st
        now = self.app.clock()
        if st["online"]:
            self.state, self.until = "online", now + 2.5
        elif not st["wifi"]:
            self.state, self.until = "nowifi", now + 6
        else:
            self.state, self.until = "choice", now + self.AUTO_OFFLINE
        self.initial_focus = "wifi" if self.state == "choice" else "continue"

    def tick(self, now):
        if self.busy:
            return True
        if self.until and now >= self.until:
            self.until = None
            self.app.goto(LicenceScreen(self.app))
            return True
        return self.until is not None and self.state == "choice"

    def on_action(self, wid):
        self.until = None
        if wid == "continue" or wid == "offline":
            self.app.goto(LicenceScreen(self.app))
        elif wid == "wifi":
            self.app.goto(WifiScreen(self.app, back=lambda ok: self.app.goto(
                LicenceScreen(self.app) if ok else NetworkScreen(self.app))))

    def draw(self, f):
        if self.busy:
            return self.draw_busy(f, "Network", self.msg)
        x, y = self.center_card(f, 720, 330)
        if self.state == "online":
            f.icon_check(x + 360, y + 70, 30)
            f.text(x + 360, y + 135, "Connected", 28, True, ui.TEXT, anchor="mm")
            f.text(x + 360, y + 178, "The reports will be uploaded to the Triple Re ERP after the erase.", 17,
                   False, ui.MUTED, anchor="mm")
            f.button("continue", x + 260, y + 236, 200, 54, "Continue", default=True)
        elif self.state == "nowifi":
            f.icon_warn(x + 360, y + 70, 30)
            f.text(x + 360, y + 135, "No network", 28, True, ui.TEXT, anchor="mm")
            f.text(x + 360, y + 178, "No cable and no Wi-Fi card. The reports will be saved on the USB drive.",
                   17, False, ui.MUTED, anchor="mm", max_w=680)
            f.button("continue", x + 260, y + 236, 200, 54, "Continue", default=True)
        else:
            left = max(0, int((self.until or self.app.clock()) - self.app.clock()))
            f.icon_warn(x + 360, y + 62, 28)
            f.text(x + 360, y + 122, "Not connected to the internet", 26, True, ui.TEXT, anchor="mm")
            f.text(x + 360, y + 160, "Connect to Wi-Fi to upload the reports to the Triple Re ERP,", 17, False,
                   ui.MUTED, anchor="mm")
            f.text(x + 360, y + 184, "or continue and the reports will be saved on the USB drive.", 17, False,
                   ui.MUTED, anchor="mm")
            f.button("wifi", x + 90, y + 226, 260, 56, "Connect to Wi-Fi", default=True)
            f.button("offline", x + 370, y + 226, 260, 56, "Continue offline", kind="secondary")
            if self.until:
                f.text(x + 360, y + 306, f"Continuing offline in {left} s", 15, False, ui.MUTED, anchor="mm")


# -------------------------------------------------------------------- Wi-Fi
class WifiScreen(BusyMixin, Screen):
    ROWS = 7

    def __init__(self, app, back):
        super().__init__(app)
        self.back = back
        self.nets = []
        self.scroll = 0
        self.ssid = ""
        self.secured = False
        self.password = ""
        self.show_pw = False
        self.error = ""

    @property
    def hint(self):
        if self.state == "password":
            return "Type the password, then press Enter.   Esc: back."
        return None

    def enter(self):
        self.scan()

    def scan(self):
        self.state, self.busy = "scanning", True
        self.app.bg(self.app.sys.wifi_scan, self._scanned)

    def _scanned(self, nets):
        self.busy = False
        self.nets = [] if isinstance(nets, Exception) else nets
        self.scroll = 0
        self.state = "list"

    def on_scroll(self, d):
        if self.state == "list":
            self.scroll = max(0, min(max(0, len(self.nets) - self.ROWS), self.scroll + d))

    def on_nav(self, wid, step):
        if self.state == "list" and wid and wid.startswith("net:"):
            i = int(wid[4:]) + step
            if 0 <= i < len(self.nets):
                self.app.focus = f"net:{i}"
                self.on_focus(self.app.focus)
                return True
        return False

    def on_focus(self, wid):
        if wid.startswith("net:"):
            i = int(wid[4:])
            if i < self.scroll:
                self.scroll = i
            elif i >= self.scroll + self.ROWS:
                self.scroll = i - self.ROWS + 1

    def on_back(self):
        if self.state in ("password", "failed"):
            self.state = "list"
        elif self.state == "list":
            self.back(False)

    def on_text(self, wid, ch):
        if wid == "pw" and len(self.password) < 63:
            self.password += ch

    def on_backspace(self, wid):
        if wid == "pw":
            self.password = self.password[:-1]

    def on_enter(self, wid):
        if wid == "pw":
            self.on_action("connect")

    def connect(self):
        self.state, self.busy, self.error = "connecting", True, ""
        ssid, pw = self.ssid, self.password if self.secured else ""

        def work():
            r = self.app.sys.wifi_connect(ssid, pw)
            if r == "ok":
                self.app.sys.sync_clock()
                self.app.net = self.app.sys.net_status()
            return r

        self.app.bg(work, self._connected)

    def _connected(self, r):
        self.busy = False
        if r == "ok":
            self.state = "save"
            self.initial_focus = "save"
        else:
            self.state = "failed"
            self.error = ("Wi-Fi passwords are 8 to 63 characters." if r == "badpass"
                          else "Check the password and try again.")
            self.initial_focus = "retry"

    def on_action(self, wid):
        if wid.startswith("net:"):
            _sig, self.secured, self.ssid = self.nets[int(wid[4:])]
            self.password, self.show_pw = "", False
            if self.secured:
                self.state = "password"
                self.initial_focus = "pw"
                self.app.focus = "pw"
            else:
                self.connect()
        elif wid == "rescan":
            self.scan()
        elif wid == "back":
            self.on_back()
        elif wid == "connect":
            if len(self.password) < 8:
                self.state, self.error, self.initial_focus = "failed", "Wi-Fi passwords are 8 to 63 characters.", "retry"
            else:
                self.connect()
        elif wid == "show":
            self.show_pw = not self.show_pw
            self.app.focus = "pw"
        elif wid == "retry":
            self.state = "password" if self.secured else "list"
            self.app.focus = "pw" if self.secured else None
        elif wid == "save":
            self.app.sys.wifi_save_last()
            self.back(True)
        elif wid == "nosave":
            self.back(True)

    def draw(self, f):
        if self.state == "scanning":
            return self.draw_busy(f, "Wi-Fi", "Searching for Wi-Fi networks...")
        if self.state == "connecting":
            return self.draw_busy(f, "Wi-Fi", f'Connecting to "{self.ssid}"...')
        cx, cy, cw, ch = self.content(f)
        if self.state == "list":
            y = self.title(f, 48, cy + 26, "Choose a Wi-Fi network")
            if not self.nets:
                f.text(48, y + 20, "No Wi-Fi networks found.", 20, False, ui.MUTED)
            rows = self.nets[self.scroll:self.scroll + self.ROWS]
            rh = 54
            for k, (sig, sec, ssid) in enumerate(rows):
                i = self.scroll + k
                ry = y + 8 + k * (rh + 8)

                def body(x, yy, w, h, sig=sig, sec=sec, ssid=ssid):
                    level = 4 if sig >= -55 else 3 if sig >= -67 else 2 if sig >= -75 else 1
                    f.wifi_bars(x + 18, yy + 15, level)
                    f.text(x + 62, yy + h / 2, ssid or "(hidden network)", 20, True, ui.TEXT, anchor="lm", max_w=w - 260)
                    f.text(x + w - 24, yy + h / 2, "Password" if sec else "Open", 16, False, ui.MUTED, anchor="rm")

                f.list_row(f"net:{i}", 48, ry, cw - 96, rh, body)
            if len(self.nets) > self.ROWS:
                f.text(cw - 48, y - 12, f"{self.scroll + 1}-{min(len(self.nets), self.scroll + self.ROWS)} of "
                       f"{len(self.nets)}  (scroll for more)", 15, False, ui.MUTED, anchor="rs")
            by = cy + ch - 80
            f.button("back", 48, by, 180, 54, "Back", kind="secondary")
            f.button("rescan", 244, by, 180, 54, "Search again", kind="secondary")
        elif self.state == "password":
            x, y = self.center_card(f, 720, 320)
            f.text(x + 40, y + 36, "Wi-Fi password", 26, True)
            f.text(x + 40, y + 78, f'Network: "{self.ssid}"', 18, False, ui.MUTED, max_w=640)
            f.text_field("pw", x + 40, y + 118, 520, 58, self.password, "Password", secret=not self.show_pw)
            f.button("show", x + 576, y + 118, 104, 58, "Hide" if self.show_pw else "Show", kind="secondary", size=17)
            f.button("back", x + 40, y + 222, 200, 56, "Back", kind="secondary")
            f.button("connect", x + 480, y + 222, 200, 56, "Connect", default=True)
        elif self.state == "failed":
            x, y = self.center_card(f, 720, 300)
            f.icon_cross(x + 360, y + 62, 28)
            f.text(x + 360, y + 122, f'Could not connect to "{self.ssid}"', 24, True, anchor="mm", max_w=660)
            f.text(x + 360, y + 160, self.error, 17, False, ui.MUTED, anchor="mm")
            f.button("back", x + 130, y + 210, 220, 56, "Back", kind="secondary")
            f.button("retry", x + 370, y + 210, 220, 56, "Try again", default=True)
        elif self.state == "save":
            x, y = self.center_card(f, 760, 320)
            f.icon_check(x + 380, y + 62, 28)
            f.text(x + 380, y + 122, f'Connected to "{self.ssid}"', 24, True, anchor="mm", max_w=700)
            f.text(x + 380, y + 162, "Save this network on the USB drive so other laptops", 17, False, ui.MUTED,
                   anchor="mm")
            f.text(x + 380, y + 186, "connect to it automatically?", 17, False, ui.MUTED, anchor="mm")
            f.button("nosave", x + 150, y + 228, 220, 56, "Don't save", kind="secondary")
            f.button("save", x + 390, y + 228, 220, 56, "Save network", default=True)


# -------------------------------------------------------------------- licence
class LicenceScreen(BusyMixin, Screen):
    TEXTS = {
        "expired": ("The licence of this USB drive has expired",
                    "Connect to the internet (cable or Wi-Fi) and choose Retry to renew it."),
        "invalid": ("The licence on this USB drive is not valid",
                    "Create a new key for this USB drive in the Triple Re ERP."),
        "disabled": ("This USB drive has been disabled",
                     "It was stopped in the Triple Re ERP. Contact the Triple Re administrator."),
        "missing": ("This USB drive is not activated",
                    "Create a key for it in the Triple Re ERP (Data Erasure Certificates page) and copy "
                    "upload.conf to /etc/triplere/ on the USB drive."),
    }

    def enter(self):
        self.busy = True
        online = self.app.net.get("online")
        self.app.bg(lambda: self.app.sys.licence(online), self._checked)

    def _checked(self, state):
        self.busy = False
        self.state = "invalid" if isinstance(state, Exception) else state
        if self.state == "valid":
            if self.app.job_asked:
                self.app.goto(DisksScreen(self.app))
            else:
                self.app.goto(JobScreen(self.app))
        self.initial_focus = "retry"

    def on_action(self, wid):
        if wid == "retry":
            self.app.net = self.app.sys.net_status()
            self.enter()
        elif wid == "wifi":
            self.app.goto(WifiScreen(self.app, back=lambda ok: self.app.goto(LicenceScreen(self.app))))
        elif wid == "poweroff":
            self.app.sys.power_off()
            self.app.goto(ByeScreen(self.app, "Powering off..."))

    def draw(self, f):
        if self.busy:
            return self.draw_busy(f, "Licence", "Checking the licence of this USB drive...")
        title, text = self.TEXTS.get(self.state, self.TEXTS["invalid"])
        x, y = self.center_card(f, 800, 360)
        f.icon_cross(x + 400, y + 62, 28)
        f.text(x + 400, y + 122, title, 26, True, anchor="mm", max_w=740)
        f.wrap(x + 60, y + 154, text, 680, 17, False, ui.MUTED)
        f.button("poweroff", x + 60, y + 268, 210, 56, "Power off", kind="secondary")
        f.button("wifi", x + 295, y + 268, 210, 56, "Connect to Wi-Fi", kind="secondary")
        f.button("retry", x + 530, y + 268, 210, 56, "Retry", default=True)


# -------------------------------------------------------------------- job details
class JobScreen(Screen):
    FIELDS = (("client_name", "Customer name", "e.g. the company the laptops came from"),
              ("technician_name", "Technician", "Your name"),
              ("work_order", "Work order (optional)", "e.g. WO-1234"))
    hint = "Tab or arrows: next field.   Enter: continue."
    initial_focus = "client_name"

    def enter(self):
        try:
            saved = self.app.sys.load_job()
        except Exception:
            saved = {}
        for k, _l, _p in self.FIELDS:
            self.app.job[k] = self.app.job.get(k) or saved.get(k, "")

    def on_text(self, wid, ch):
        if len(self.app.job[wid]) < 80:
            self.app.job[wid] += ch

    def on_backspace(self, wid):
        self.app.job[wid] = self.app.job[wid][:-1]

    def on_enter(self, wid):
        keys = [k for k, _l, _p in self.FIELDS]
        i = keys.index(wid)
        if i + 1 < len(keys):
            self.app.focus = keys[i + 1]
        else:
            self.on_action("continue")

    def on_action(self, wid):
        if wid == "continue":
            try:
                self.app.sys.save_job(self.app.job)
            except Exception:
                pass
            self.app.job_asked = True
            self.app.goto(DisksScreen(self.app))

    def draw(self, f):
        x, y = self.center_card(f, 760, 470)
        f.text(x + 44, y + 34, "Job details", 28, True)
        f.text(x + 44, y + 78, "Printed on the reports in the ERP. Kept on the USB drive for the next laptops.",
               16, False, ui.MUTED, max_w=680)
        yy = y + 120
        for k, label, ph in self.FIELDS:
            f.text(x + 44, yy, label, 17, True, ui.TEXT)
            f.text_field(k, x + 44, yy + 26, 672, 52, self.app.job[k], ph)
            yy += 96
        f.button("continue", x + 516, y + 398, 200, 54, "Continue", default=True)


# -------------------------------------------------------------------- disks
class DisksScreen(BusyMixin, Screen):
    ROWS = 5

    def __init__(self, app):
        super().__init__(app)
        self.disks = []
        self.selected = set()
        self.method = "recommended"
        self.scroll = 0

    def enter(self):
        self.busy = True
        self.app.bg(self.app.sys.list_disks, self._listed)

    def _listed(self, disks):
        self.busy = False
        self.disks = [] if isinstance(disks, Exception) else disks
        self.selected = {d.name for d in self.disks if not d.usb}
        self.scroll = 0
        self.initial_focus = "erase" if self.selected else ("disk:0" if self.disks else "rescan")

    def on_scroll(self, d):
        self.scroll = max(0, min(max(0, len(self.disks) - self.ROWS), self.scroll + d))

    def on_nav(self, wid, step):
        if wid and wid.startswith("disk:"):
            i = int(wid[5:]) + step
            if 0 <= i < len(self.disks):
                self.app.focus = f"disk:{i}"
                self.on_focus(self.app.focus)
                return True
        return False

    def on_focus(self, wid):
        if wid.startswith("disk:"):
            i = int(wid[5:])
            if i < self.scroll:
                self.scroll = i
            elif i >= self.scroll + self.ROWS:
                self.scroll = i - self.ROWS + 1

    def on_action(self, wid):
        if wid.startswith("disk:"):
            name = self.disks[int(wid[5:])].name
            self.selected ^= {name}
        elif wid.startswith("method:"):
            self.method = wid[7:]
        elif wid == "rescan":
            self.enter()
        elif wid == "classic":
            self.app.exit_code = EXIT_CLASSIC
        elif wid == "editjob":
            self.app.goto(JobScreen(self.app))
        elif wid == "erase" and self.selected:
            chosen = [d for d in self.disks if d.name in self.selected]
            self.app.goto(ConfirmScreen(self.app, chosen, self.method, self))

    def method_for(self, d):
        if self.method == "recommended":
            return "Firmware erase (sanitize)" if d.firmware_erase else "Overwrite + verify"
        return METHODS[self.method][0]

    def draw(self, f):
        if self.busy:
            return self.draw_busy(f, "Disks", "Looking for disks...")
        cx, cy, cw, ch = self.content(f)
        self.title(f, 48, cy + 22, "Select the disks to erase")
        job = self.app.job
        info = "   ".join(p for p in (
            ("Customer: " + job["client_name"]) if job.get("client_name") else "Customer: -",
            ("Technician: " + job["technician_name"]) if job.get("technician_name") else "Technician: -",
            ("WO: " + job["work_order"]) if job.get("work_order") else "") if p)
        f.text(48, cy + 70, info, 16, False, ui.MUTED, max_w=cw - 260)
        f.button("editjob", cw - 48 - 170, cy + 24, 170, 42, "Edit job details", kind="secondary", size=15)

        y0 = cy + 104
        rh = 74
        if not self.disks:
            f.box(48, y0, cw - 96, 120)
            f.text(cw / 2, y0 + 44, "No disks found", 22, True, anchor="mm")
            f.text(cw / 2, y0 + 80, "Connect the disk and choose Search again.", 17, False, ui.MUTED, anchor="mm")
        for k, d in enumerate(self.disks[self.scroll:self.scroll + self.ROWS]):
            i = self.scroll + k
            ry = y0 + k * (rh + 10)

            def body(x, yy, w, h, d=d):
                f.text(x, yy + 14, d.label, 20, True, ui.TEXT, max_w=w - 330)
                sub = f"{d.kind}   {human_size(d.size)}   S/N {d.serial or 'unknown'}   /dev/{d.name}"
                f.text(x, yy + 44, sub, 16, False, ui.MUTED, max_w=w - 330)
                m = self.method_for(d)
                tw = f.text_width(m, 15, True) + 28
                f.box(x + w - tw - 20, yy + (h - 32) / 2, tw, 32, fill=ui.WHITE, outline=ui.BORDER, radius=16)
                f.text(x + w - 20 - tw / 2, yy + h / 2, m, 15, True, ui.GREEN_DARK, anchor="mm")

            f.checkbox_row(f"disk:{i}", 48, ry, cw - 96, rh, d.name in self.selected, body)
        if len(self.disks) > self.ROWS:
            f.text(cw - 48, y0 - 8, f"{self.scroll + 1}-{min(len(self.disks), self.scroll + self.ROWS)} of "
                   f"{len(self.disks)} disks (scroll for more)", 15, False, ui.MUTED, anchor="rs")

        # method + actions
        by = cy + ch - 136
        f.text(48, by + 4, "Erase method", 16, True, ui.TEXT)
        mx = 48
        for mid, (label, _args) in METHODS.items():
            w = f.text_width(label, 16, True) + 40
            f.button(f"method:{mid}", mx, by + 28, w, 42, label, kind="primary" if self.method == mid else "secondary",
                     size=16)
            mx += w + 10
        note = {"recommended": "SSD / NVMe: the drive's own sanitize.  Hard disks and USB: overwrite + verify.",
                "overwrite": "One pass of zeros on every disk, then read back to verify.",
                "dod": "Three passes, then a pass of zeros, then read back to verify. Slow."}[self.method]
        f.text(mx + 10, by + 49, note, 15, False, ui.MUTED, anchor="lm", max_w=cw - mx - 60)

        ay = cy + ch - 62
        f.button("rescan", 48, ay, 170, 50, "Search again", kind="secondary", size=17)
        f.button("classic", 230, ay, 190, 50, "Classic screen", kind="secondary", size=17)
        n = len(self.selected)
        f.button("erase", cw - 48 - 290, ay, 290, 50, f"Erase {n} disk{'s' if n != 1 else ''}" if n else "Select a disk",
                 kind="danger", enabled=n > 0, size=19)


class ConfirmScreen(Screen):
    initial_focus = "cancel"

    def __init__(self, app, disks, method, back):
        super().__init__(app)
        self.disks = disks
        self.method = method
        self.back = back

    def on_back(self):
        self.app.screen = self.back
        self.app.focus = "erase"

    def on_action(self, wid):
        if wid == "cancel":
            self.on_back()
        elif wid == "go":
            job = self.app.sys.start_wipe(self.disks, self.method)
            self.app.goto(ProgressScreen(self.app, job))

    def draw(self, f):
        n = len(self.disks)
        h = 300 + 34 * min(n, 6)
        x, y = self.center_card(f, 820, h)
        f.d.rounded_rectangle(f.rect(x, y, 820, 70), radius=f.px(16), fill=ui.RED)
        f.d.rectangle(f.rect(x, y + 40, 820, 30), fill=ui.RED)
        f.text(x + 410, y + 35, f"Erase {n} disk{'s' if n != 1 else ''}?", 26, True, ui.WHITE, anchor="mm")
        yy = y + 96
        for d in self.disks[:6]:
            f.text(x + 50, yy, f"{d.label}  -  {human_size(d.size)}  -  S/N {d.serial or 'unknown'}", 18, True,
                   max_w=720)
            yy += 34
        if n > 6:
            f.text(x + 50, yy, f"... and {n - 6} more", 17, False, ui.MUTED)
            yy += 34
        yy += 10
        f.text(x + 50, yy, "All data on these disks will be destroyed. This cannot be undone.", 18, True, ui.RED)
        f.text(x + 50, yy + 32, "Do not power off or unplug the USB drive until the reports are saved.", 16, False,
               ui.MUTED)
        f.button("cancel", x + 50, y + h - 84, 300, 58, "Cancel", kind="secondary")
        f.button("go", x + 470, y + h - 84, 300, 58, "Yes, erase now", kind="danger")


# -------------------------------------------------------------------- progress
def _fmt_elapsed(sec):
    sec = int(sec)
    return f"{sec // 3600:d}:{sec % 3600 // 60:02d}:{sec % 60:02d}"


class ProgressScreen(Screen):
    hint = "The erase runs by itself. Do not power off or unplug the USB drive."

    def __init__(self, app, job):
        super().__init__(app)
        self.job = job
        self.confirm_stop = False
        self.initial_focus = None

    def tick(self, now):
        if self.job.done:
            self.app.goto(ReportsScreen(self.app, self.job))
        return True

    def on_action(self, wid):
        if wid == "stop":
            self.confirm_stop = True
            self.app.focus = "keep"
        elif wid == "keep":
            self.confirm_stop = False
        elif wid == "stopnow":
            self.confirm_stop = False
            self.job.cancel()

    def draw(self, f):
        cx, cy, cw, ch = self.content(f)
        job = self.job
        elapsed = self.app.clock() - job.started
        self.title(f, 48, cy + 22, "Erasing" if not job.cancelled else "Stopping...")
        f.text(cw - 48, cy + 40, f"Elapsed {_fmt_elapsed(elapsed)}", 18, True, ui.MUTED, anchor="rm")
        states = list(job.states.values())
        rh = min(96, (ch - 190) / max(1, len(states)) - 10)
        y = cy + 86
        for st in states:
            f.box(48, y, cw - 96, rh)
            d = st.disk
            f.text(72, y + 14, d.label, 19, True, max_w=cw - 520)
            f.text(72, y + 42, f"{d.kind}  {human_size(d.size)}  S/N {d.serial or 'unknown'}", 15, False, ui.MUTED,
                   max_w=cw - 520)
            stage = st.stage if not st.result else {"erased": "Erased", "failed": "Failed", "aborted": "Stopped"}[st.result]
            if st.fell_back and not st.result:
                stage = "Overwrite (firmware erase not available) - " + stage
            col = ui.RED if st.result == "failed" else ui.TEXT
            f.text(cw - 72, y + 14, stage, 16, True, col, anchor="ra", max_w=420)
            pct = f"{st.fraction * 100:.1f}%" if st.fraction else ""
            eta = f"   about {st.eta} left" if st.eta and not st.result else ""
            f.text(cw - 72, y + 42, pct + eta, 15, False, ui.MUTED, anchor="ra")
            bar_y = y + rh - 26
            if st.fraction <= 0 and not st.result and st.stage not in ("Waiting",):
                f.progress(72, bar_y, cw - 144, 12, 0, indeterminate_phase=self.phase())
            else:
                f.progress(72, bar_y, cw - 144, 12, st.fraction, color=ui.RED if st.result == "failed" else ui.GREEN)
            y += rh + 10
        f.icon_warn(66, cy + ch - 62, 14)
        f.text(92, cy + ch - 62, "Do not power off the laptop or unplug the USB drive.", 17, True, ui.AMBER, anchor="lm")
        if job.can_cancel:
            f.button("stop", cw - 48 - 200, cy + ch - 88, 200, 52, "Stop", kind="secondary")
        if self.confirm_stop:
            x, yy = self.center_card(f, 660, 260)
            f.text(x + 330, yy + 50, "Stop the erase?", 26, True, anchor="mm")
            f.text(x + 330, yy + 96, "The disks will be left partly erased and marked as failed.", 17, False,
                   ui.MUTED, anchor="mm")
            f.zones.clear()
            f.order.clear()
            f.button("keep", x + 60, yy + 160, 250, 56, "Keep erasing", default=True)
            f.button("stopnow", x + 350, yy + 160, 250, 56, "Stop", kind="danger")


# -------------------------------------------------------------------- reports
class ReportsScreen(Screen):
    def __init__(self, app, job):
        super().__init__(app)
        self.job = job
        self.step = "saving"  # saving, uploading, done
        self.saved = None
        self.uploaded = None
        self.reason = ""
        self.initial_focus = "poweroff"

    def enter(self):
        self.app.bg(self.app.sys.save_reports, self._saved)

    def _saved(self, ok):
        self.saved = ok is True
        self.app.net = self.app.sys.net_status() if not isinstance(ok, Exception) else self.app.net
        self._upload()

    def _upload(self):
        if not self.app.net.get("online"):
            self.uploaded, self.reason, self.step = False, "no internet connection", "done"
            return
        self.step = "uploading"
        self.app.bg(lambda: self.app.sys.upload(self.job.logs), self._uploaded)

    def _uploaded(self, r):
        if isinstance(r, Exception):
            r = (False, str(r)[:60])
        self.uploaded, self.reason = r
        self.step = "done"

    def tick(self, now):
        return self.step != "done"

    def on_action(self, wid):
        if self.step != "done":
            return
        if wid == "more":
            self.app.goto(DisksScreen(self.app))
        elif wid == "retry":
            self.app.net = self.app.sys.net_status()
            self._upload()
        elif wid == "wifi":
            self.app.goto(WifiScreen(self.app, back=lambda ok: self._back_from_wifi()))
        elif wid == "reboot":
            self.app.sys.reboot()
            self.app.goto(ByeScreen(self.app, "Restarting..."))
        elif wid == "poweroff":
            self.app.sys.power_off()
            self.app.goto(ByeScreen(self.app, "Powering off..."))

    def _back_from_wifi(self):
        self.app.screen = self
        self.app.focus = None
        self._upload()

    def draw(self, f):
        cx, cy, cw, ch = self.content(f)
        states = list(self.job.states.values())
        ok = sum(1 for s in states if s.result == "erased")
        bad = len(states) - ok
        title = "Erase complete" if not bad else ("Erase finished with problems" if ok else "Erase failed")
        self.title(f, 48, cy + 22, title)
        rh = min(64, (ch - 300) / max(1, len(states)) - 8)
        y = cy + 84
        for st in states:
            f.box(48, y, cw - 96, rh)
            if st.result == "erased":
                f.icon_check(80, y + rh / 2, 15)
            elif st.result == "aborted":
                f.icon_warn(80, y + rh / 2, 15)
            else:
                f.icon_cross(80, y + rh / 2, 15)
            d = st.disk
            f.text(108, y + rh / 2, f"{d.label}  -  {human_size(d.size)}  -  S/N {d.serial or 'unknown'}", 18, True,
                   anchor="lm", max_w=cw - 640)
            word = {"erased": "ERASED", "aborted": "STOPPED"}.get(st.result, "FAILED")
            col = ui.GREEN if st.result == "erased" else ui.RED
            f.text(cw - 72, y + rh / 2 - 9, word, 17, True, col, anchor="rm")
            f.text(cw - 72, y + rh / 2 + 13, st.detail, 14, False, ui.MUTED, anchor="rm", max_w=520)
            y += rh + 8
        if bad:
            f.text(48, y + 6, "For a failed disk choose Erase more disks and pick \"Overwrite + verify\".", 16, False,
                   ui.MUTED)

        # reports panel
        py = cy + ch - 196
        f.box(48, py, cw - 96, 110)
        if self.step == "saving":
            f.spinner(88, py + 55, 18, self.phase())
            f.text(124, py + 55, "Saving the reports on the USB drive...", 20, True, anchor="lm")
        elif self.step == "uploading":
            f.spinner(88, py + 55, 18, self.phase())
            f.text(124, py + 40, "Uploading the reports to the Triple Re ERP...", 20, True, anchor="lm")
            f.text(124, py + 72, "This can take up to 2 minutes.", 16, False, ui.MUTED, anchor="lm")
        else:
            if self.uploaded:
                f.icon_check(88, py + 55, 20)
                f.text(124, py + 38, "Reports uploaded to the Triple Re ERP", 20, True, anchor="lm")
                f.text(124, py + 72, "A copy is also saved on the USB drive.  It is now safe to power off.", 16, False,
                       ui.MUTED, anchor="lm")
            else:
                f.icon_warn(88, py + 55, 20)
                f.text(124, py + 38, "Reports saved on the USB drive only" if self.saved else
                       "Reports could not be saved on the USB drive", 20, True, anchor="lm")
                why = self.reason or "no internet connection"
                f.text(124, py + 72, f"Not uploaded ({why}). Upload them later from the ERP page "
                       "\"Data Erasure Certificates\".", 16, False, ui.MUTED, anchor="lm", max_w=cw - 460)
                if self.app.net.get("online"):
                    f.button("retry", cw - 48 - 220, py + 30, 200, 50, "Retry upload", kind="secondary", size=17)
                else:
                    f.button("wifi", cw - 48 - 220, py + 30, 200, 50, "Connect to Wi-Fi", kind="secondary", size=17)
        ay = cy + ch - 70
        done = self.step == "done"
        f.button("more", 48, ay, 250, 54, "Erase more disks", kind="secondary", enabled=done)
        f.button("reboot", cw - 48 - 460, ay, 210, 54, "Restart", kind="secondary", enabled=done)
        f.button("poweroff", cw - 48 - 230, ay, 230, 54, "Power off", enabled=done, default=True)


class ByeScreen(Screen):
    def __init__(self, app, text):
        super().__init__(app)
        self.text = text

    def draw(self, f):
        x, y = self.center_card(f, 560, 160)
        f.text(x + 280, y + 80, self.text, 24, True, anchor="mm")
