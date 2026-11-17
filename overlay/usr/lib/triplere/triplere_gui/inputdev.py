"""Keyboard, mouse, touchpad and touchscreen input straight from /dev/input/event*.

Keyboards are grabbed (EVIOCGRAB) so key presses do not also reach the text console
underneath; the grab ends by itself when the process exits, even after a crash.
New devices (a USB mouse plugged in later) are picked up every few seconds.
"""

import fcntl
import glob
import os
import select
import struct
import time
from dataclasses import dataclass

EV_SYN, EV_KEY, EV_REL, EV_ABS = 0, 1, 2, 3
REL_X, REL_Y, REL_WHEEL = 0, 1, 8
ABS_X, ABS_Y = 0, 1
BTN_LEFT, BTN_RIGHT, BTN_TOUCH, BTN_TOOL_FINGER = 0x110, 0x111, 0x14A, 0x145
INPUT_PROP_DIRECT = 0x01

EVENT = struct.Struct("llHHi")  # struct input_event on 64-bit Linux


def _ioc(direction, nr, size):
    return (direction << 30) | (size << 16) | (ord("E") << 8) | nr


def EVIOCGBIT(ev, length):
    return _ioc(2, 0x20 + ev, length)


def EVIOCGABS(axis):
    return _ioc(2, 0x40 + axis, 24)


EVIOCGPROP = _ioc(2, 0x09, 8)
EVIOCGRAB = _ioc(1, 0x90, 4)

# US layout: evdev key code -> (plain, shifted)
KEYMAP = {
    2: ("1", "!"), 3: ("2", "@"), 4: ("3", "#"), 5: ("4", "$"), 6: ("5", "%"), 7: ("6", "^"),
    8: ("7", "&"), 9: ("8", "*"), 10: ("9", "("), 11: ("0", ")"), 12: ("-", "_"), 13: ("=", "+"),
    16: ("q", "Q"), 17: ("w", "W"), 18: ("e", "E"), 19: ("r", "R"), 20: ("t", "T"), 21: ("y", "Y"),
    22: ("u", "U"), 23: ("i", "I"), 24: ("o", "O"), 25: ("p", "P"), 26: ("[", "{"), 27: ("]", "}"),
    30: ("a", "A"), 31: ("s", "S"), 32: ("d", "D"), 33: ("f", "F"), 34: ("g", "G"), 35: ("h", "H"),
    36: ("j", "J"), 37: ("k", "K"), 38: ("l", "L"), 39: (";", ":"), 40: ("'", '"'), 41: ("`", "~"),
    43: ("\\", "|"), 44: ("z", "Z"), 45: ("x", "X"), 46: ("c", "C"), 47: ("v", "V"), 48: ("b", "B"),
    49: ("n", "N"), 50: ("m", "M"), 51: (",", "<"), 52: (".", ">"), 53: ("/", "?"), 57: (" ", " "),
    # keypad
    71: ("7", "7"), 72: ("8", "8"), 73: ("9", "9"), 74: ("-", "-"), 75: ("4", "4"), 76: ("5", "5"),
    77: ("6", "6"), 78: ("+", "+"), 79: ("1", "1"), 80: ("2", "2"), 81: ("3", "3"), 82: ("0", "0"),
    83: (".", "."), 55: ("*", "*"), 98: ("/", "/"),
}
NAMED = {
    1: "esc", 14: "backspace", 15: "tab", 28: "enter", 96: "enter", 57: "space",
    103: "up", 108: "down", 105: "left", 106: "right", 102: "home", 107: "end",
    104: "pageup", 109: "pagedown", 111: "delete",
}
SHIFT = {42, 54}
CTRL = {29, 97}
ALT = {56, 100}
CAPSLOCK = 58


@dataclass
class Key:
    name: str  # "enter", "tab", ... or "char"
    char: str = ""
    shift: bool = False
    ctrl: bool = False


@dataclass
class Pointer:
    kind: str  # "move", "click", "scroll"
    x: int = 0
    y: int = 0
    delta: int = 0


def _bits(fd, ev, nbytes):
    try:
        buf = fcntl.ioctl(fd, EVIOCGBIT(ev, nbytes), bytes(nbytes))
    except OSError:
        return 0
    return int.from_bytes(buf, "little")


def _has(bits, code):
    return bool(bits >> code & 1)


class _Device:
    def __init__(self, path, fd):
        self.path = path
        self.fd = fd
        ev = _bits(fd, 0, 4)
        keys = _bits(fd, EV_KEY, 96) if _has(ev, EV_KEY) else 0
        rel = _bits(fd, EV_REL, 4) if _has(ev, EV_REL) else 0
        absb = _bits(fd, EV_ABS, 8) if _has(ev, EV_ABS) else 0
        try:
            props = int.from_bytes(fcntl.ioctl(fd, EVIOCGPROP, bytes(8)), "little")
        except OSError:
            props = 0
        self.keyboard = all(_has(keys, k) for k in (28, 30, 57))
        self.mouse = _has(rel, REL_X) and _has(rel, REL_Y)
        self.abs = _has(absb, ABS_X) and _has(absb, ABS_Y)
        self.touchscreen = self.abs and _has(props, INPUT_PROP_DIRECT)
        self.touchpad = self.abs and not self.touchscreen and _has(keys, BTN_TOOL_FINGER)
        # absolute pointer with buttons: graphics tablets, KVM consoles, virtual machines
        self.tablet = self.abs and not self.touchscreen and not self.touchpad and _has(keys, BTN_LEFT)
        self.abs_range = {}
        if self.abs:
            for axis in (ABS_X, ABS_Y):
                try:
                    info = fcntl.ioctl(fd, EVIOCGABS(axis), bytes(24))
                    _val, lo, hi = struct.unpack_from("3i", info)
                    self.abs_range[axis] = (lo, hi if hi > lo else lo + 1)
                except OSError:
                    self.abs_range[axis] = (0, 1)
        # touch state
        self.touching = False
        self.touch_start = 0.0
        self.touch_moved = 0.0
        self.last_abs = None
        self.cur_abs = [None, None]
        self.useful = self.keyboard or self.mouse or self.touchpad or self.touchscreen or self.tablet


class InputManager:
    def __init__(self, width, height, scan_interval=3.0):
        self.width = width
        self.height = height
        self.devices = {}
        self.pointer = [width // 2, height // 2]
        self.pointer_seen = False
        self.shift = set()
        self.ctrl = set()
        self.alt = set()
        self.capslock = False
        self.scan_interval = scan_interval
        self.last_scan = 0.0
        self.ignored = set()
        self.rescan()

    def rescan(self):
        self.last_scan = time.monotonic()
        present = set(glob.glob("/dev/input/event*"))
        for path in list(self.devices):
            if path not in present:
                self._drop(path)
        for path in sorted(present - set(self.devices) - self.ignored):
            try:
                fd = os.open(path, os.O_RDONLY | os.O_NONBLOCK)
            except OSError:
                continue
            dev = _Device(path, fd)
            if not dev.useful:
                os.close(fd)
                self.ignored.add(path)
                continue
            if dev.keyboard:
                try:
                    fcntl.ioctl(fd, EVIOCGRAB, 1)
                except OSError:
                    pass
            self.devices[path] = dev

    def _drop(self, path):
        dev = self.devices.pop(path, None)
        if dev:
            try:
                os.close(dev.fd)
            except OSError:
                pass

    def close(self):
        for path in list(self.devices):
            self._drop(path)

    def poll(self, timeout):
        """Waits up to `timeout` seconds; returns a list of Key / Pointer events."""
        if time.monotonic() - self.last_scan > self.scan_interval:
            self.rescan()
        fds = {d.fd: d for d in self.devices.values()}
        if not fds:
            time.sleep(timeout)
            return []
        try:
            ready, _, _ = select.select(list(fds), [], [], timeout)
        except (OSError, ValueError):
            self.rescan()
            return []
        out = []
        for fd in ready:
            dev = fds[fd]
            try:
                data = os.read(fd, EVENT.size * 64)
            except BlockingIOError:
                continue
            except OSError:
                self._drop(dev.path)
                continue
            for i in range(0, len(data) - EVENT.size + 1, EVENT.size):
                _s, _us, etype, code, value = EVENT.unpack_from(data, i)
                self._event(dev, etype, code, value, out)
        return out

    # ------------------------------------------------------------------
    def _move_by(self, dx, dy, out):
        self.pointer[0] = min(self.width - 1, max(0, self.pointer[0] + dx))
        self.pointer[1] = min(self.height - 1, max(0, self.pointer[1] + dy))
        self.pointer_seen = True
        out.append(Pointer("move", self.pointer[0], self.pointer[1]))

    def _event(self, dev, etype, code, value, out):
        if etype == EV_KEY:
            if code in SHIFT:
                (self.shift.add if value else self.shift.discard)(dev.path)
                return
            if code in CTRL:
                (self.ctrl.add if value else self.ctrl.discard)(dev.path)
                return
            if code in ALT:
                (self.alt.add if value else self.alt.discard)(dev.path)
                return
            if code == CAPSLOCK and value == 1:
                self.capslock = not self.capslock
                return
            if code in (BTN_LEFT, BTN_RIGHT) and value == 1:
                if dev.touchscreen:
                    return
                # a clickpad press also lifts the finger quickly: do not count it as a tap too
                dev.touch_moved = float("inf")
                self.pointer_seen = True
                out.append(Pointer("click", self.pointer[0], self.pointer[1]))
                return
            if code == BTN_TOUCH or code == BTN_TOOL_FINGER:
                if dev.touchscreen or dev.touchpad:
                    self._touch(dev, value, out)
                return
            if value == 0:  # key release
                return
            shift = bool(self.shift)
            if code in NAMED and code != 57:
                out.append(Key(NAMED[code], shift=shift, ctrl=bool(self.ctrl)))
            elif code in KEYMAP:
                plain, shifted = KEYMAP[code]
                ch = shifted if shift else plain
                if self.capslock and ch.isalpha():
                    ch = ch.swapcase()
                out.append(Key("char", ch, shift=shift, ctrl=bool(self.ctrl)))
        elif etype == EV_REL and dev.mouse:
            if code == REL_X:
                self._move_by(value, 0, out)
            elif code == REL_Y:
                self._move_by(0, value, out)
            elif code == REL_WHEEL:
                out.append(Pointer("scroll", self.pointer[0], self.pointer[1], value))
        elif etype == EV_ABS and (dev.touchpad or dev.touchscreen or dev.tablet) and code in (ABS_X, ABS_Y):
            dev.cur_abs[code] = value
        elif etype == EV_SYN:
            self._abs_frame(dev, out)

    def _scale(self, dev, axis, value):
        lo, hi = dev.abs_range.get(axis, (0, 1))
        size = self.width if axis == ABS_X else self.height
        return int((value - lo) * (size - 1) / (hi - lo))

    def _abs_frame(self, dev, out):
        x, y = dev.cur_abs
        if x is None or y is None:
            return
        if dev.tablet:
            pos = [self._scale(dev, ABS_X, x), self._scale(dev, ABS_Y, y)]
            if pos != self.pointer:
                self.pointer = pos
                self.pointer_seen = True
                out.append(Pointer("move", *self.pointer))
            return
        if dev.touchscreen:
            if dev.touching:
                self.pointer = [self._scale(dev, ABS_X, x), self._scale(dev, ABS_Y, y)]
                self.pointer_seen = True
                out.append(Pointer("move", *self.pointer))
            return
        if not dev.touching:
            return
        if dev.last_abs is not None:
            lx, ly = dev.last_abs
            # relative movement like a laptop touchpad; ~1.6 screen widths per pad width
            sx = 1.6 * self.width / max(1, dev.abs_range[ABS_X][1] - dev.abs_range[ABS_X][0])
            sy = 1.6 * self.width / max(1, dev.abs_range[ABS_X][1] - dev.abs_range[ABS_X][0])
            dx, dy = int(round((x - lx) * sx)), int(round((y - ly) * sy))
            if dx or dy:
                dev.touch_moved += abs(dx) + abs(dy)
                self._move_by(dx, dy, out)
        dev.last_abs = (x, y)

    def _touch(self, dev, value, out):
        now = time.monotonic()
        if value and not dev.touching:
            dev.touching = True
            dev.touch_start = now
            dev.touch_moved = 0.0
            dev.last_abs = None
            if dev.touchscreen:
                self._abs_frame(dev, out)
        elif not value and dev.touching:
            dev.touching = False
            dev.last_abs = None
            if dev.touchscreen:
                out.append(Pointer("click", self.pointer[0], self.pointer[1]))
            elif now - dev.touch_start < 0.25 and dev.touch_moved < self.width * 0.01:
                # tap to click
                out.append(Pointer("click", self.pointer[0], self.pointer[1]))
