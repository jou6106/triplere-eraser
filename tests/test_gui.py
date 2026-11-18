"""Graphical screens, run off-screen with a simulated machine and scripted input.

    python3 -m unittest tests.test_gui            (needs Pillow)
    TRIPLERE_SHOTS=/some/dir python3 -m unittest tests.test_gui   (also saves a PNG per step)

The same App code runs on the USB drive; only the display (PNG instead of /dev/fb0), the
input (scripted instead of /dev/input) and the machine (FakeSystem) are replaced.
"""

import os
import sys
import time
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "overlay", "usr", "lib", "triplere"))

from PIL import Image  # noqa: E402

from triplere_gui import app as appmod  # noqa: E402
from triplere_gui.display import ImageDisplay  # noqa: E402
from triplere_gui.inputdev import Key, Pointer  # noqa: E402
from triplere_gui.system import Disk, DiskState  # noqa: E402

SHOTS = os.environ.get("TRIPLERE_SHOTS")
LOGO = os.path.join(HERE, "..", "usb", "etc", "nwipe", "logo.jpg")


class FakeClock:
    def __init__(self):
        self.t = 1000.0

    def __call__(self):
        return self.t


class ScriptedInput:
    def __init__(self):
        self.queue = []
        self.devices = {}

    def poll(self, timeout):
        out, self.queue = self.queue, []
        return out

    def close(self):
        pass


class FakeJob:
    def __init__(self, disks, method, outcome):
        self.disks = disks
        self.method = method
        self.states = {}
        for d in disks:
            mode = "sanitize" if (method == "recommended" and d.firmware_erase) else "overwrite"
            self.states[d.name] = DiskState(d, mode)
        self.logs = ["/nwipe_log_20261117-101010.txt"]
        self.phase = "overwrite"
        self.started = 0.0
        self.cancelled = False
        self.outcome = outcome

    @property
    def done(self):
        return self.phase == "done"

    @property
    def can_cancel(self):
        return self.phase == "overwrite" and not self.cancelled

    def cancel(self):
        self.cancelled = True

    def advance(self, fraction):
        for st in self.states.values():
            st.fraction = fraction
            st.stage = "Firmware erase" if st.mode == "sanitize" else "Writing (pass 1 of 2)"
            st.eta = "0:12:30" if st.mode == "overwrite" else ""

    def finish(self):
        for name, st in self.states.items():
            ok = self.outcome.get(name, True)
            st.result = "erased" if ok else "failed"
            st.fraction = 1.0 if ok else st.fraction
            st.detail = ("Firmware erase (Block Erase)" if st.mode == "sanitize" else "Overwritten and verified") \
                if ok else "Firmware erase failed: rejected by the drive"
        self.phase = "done"


class FakeSystem:
    def __init__(self, online=False, wifi=True, saved=False, licence="valid", connect_ok=True, upload_ok=True,
                 disks=None, outcome=None):
        self.online = online
        self.wifi = wifi
        self.saved = saved
        self.licence_state = licence
        self.connect_ok = connect_ok
        self.upload_ok = upload_ok
        self.disks = disks if disks is not None else [
            Disk("nvme0n1", 256060514304, "BC511 NVMe SK hynix 256GB", "CS03N767510103S5V", "NVMe", False),
            Disk("sda", 500107862016, "ST500LM034-2GH17A", "WGS3K2LX", "HDD", False),
            Disk("sdc", 32017047552, "SanDisk Cruzer Blade", "4C530001", "USB", True),
        ]
        self.outcome = outcome or {}
        self.calls = []
        self.job = None
        self.saved_job = {}

    def net_status(self):
        return {"online": self.online, "wifi": self.wifi, "ssid": "TripleRe-Office" if self.online else "",
                "wired": False}

    def has_saved_wifi(self):
        return self.saved

    def net_connect_saved(self):
        self.calls.append("connect-saved")
        return False

    def sync_clock(self):
        pass

    def wifi_scan(self):
        self.calls.append("scan")
        return [(-48, True, "TripleRe-Office"), (-63, True, "Warehouse"), (-80, False, "Guest")]

    def wifi_connect(self, ssid, password):
        self.calls.append(("connect", ssid, password))
        if self.connect_ok:
            self.online = True
            return "ok"
        return "fail"

    def wifi_save_last(self):
        self.calls.append("save-wifi")

    def licence(self, online):
        self.calls.append(("licence", online))
        return self.licence_state

    def load_job(self):
        return {"client_name": "", "technician_name": "Ahmed", "work_order": ""}

    def save_job(self, job):
        self.saved_job = dict(job)

    def list_disks(self):
        return list(self.disks)

    def start_wipe(self, disks, method):
        self.calls.append(("wipe", [d.name for d in disks], method))
        self.job = FakeJob(disks, method, self.outcome)
        return self.job

    def save_reports(self):
        self.calls.append("save-reports")
        return True

    def upload(self, logs):
        self.calls.append(("upload", list(logs)))
        return (True, "") if self.upload_ok else (False, "No connection to the ERP")

    def power_off(self):
        self.calls.append("poweroff")

    def reboot(self):
        self.calls.append("reboot")


class GuiHarness:
    def __init__(self, test, system, size=(1280, 720)):
        self.test = test
        self.sys = system
        self.display = ImageDisplay(*size)
        self.inputs = ScriptedInput()
        self.clock = FakeClock()
        logo = Image.open(LOGO).convert("RGB") if os.path.exists(LOGO) else None
        self.app = appmod.App(self.display, self.inputs, system, logo, clock=self.clock)
        self.app.goto(appmod.NetworkScreen(self.app))
        self.n = 0

    def settle(self, seconds=0.0, rounds=6):
        """Lets background work finish and time pass."""
        for _ in range(rounds):
            deadline = time.monotonic() + 2.0
            while self.app.results.empty() and time.monotonic() < deadline and self._pending():
                time.sleep(0.01)
            self.app.step(0)
        if seconds:
            self.clock.t += seconds
            self.app.step(0)
            self.app.step(0)

    def _pending(self):
        return any(t.name != "MainThread" and t.is_alive() for t in __import__("threading").enumerate())

    def keys(self, *names, text=None):
        for n in names:
            if isinstance(n, tuple):
                self.inputs.queue.append(Key(n[0], shift=True))
            else:
                self.inputs.queue.append(Key(n))
        if text:
            for ch in text:
                self.inputs.queue.append(Key("char", ch, shift=ch.isupper()))
        self.settle()

    def click(self, wid):
        r = dict(self.app.zones).get(wid)
        self.test.assertIsNotNone(r, f"no clickable {wid!r} on {type(self.app.screen).__name__}: "
                                     f"{[z for z, _ in self.app.zones]}")
        x, y = (r[0] + r[2]) // 2, (r[1] + r[3]) // 2
        self.inputs.queue += [Pointer("move", x, y), Pointer("click", x, y)]
        self.settle()

    def screen(self):
        return type(self.app.screen).__name__

    def shot(self, name):
        self.app.render()
        self.n += 1
        if SHOTS:
            os.makedirs(SHOTS, exist_ok=True)
            self.display.save(os.path.join(SHOTS, f"{self.test._testMethodName}_{self.n:02d}_{name}.png"))


class GuiFlowTest(unittest.TestCase):
    def test_full_flow_offline_wifi_then_wipe_and_upload(self):
        s = FakeSystem(online=False, wifi=True)
        g = GuiHarness(self, s)
        g.settle()
        self.assertEqual(g.screen(), "NetworkScreen")
        self.assertEqual(g.app.screen.state, "choice")
        self.assertEqual(g.app.focus, "wifi")
        g.shot("network_choice")

        g.click("wifi")
        g.settle()
        self.assertEqual(g.screen(), "WifiScreen")
        self.assertEqual(g.app.screen.state, "list")
        g.shot("wifi_list")

        g.click("net:0")
        self.assertEqual(g.app.screen.state, "password")
        self.assertEqual(g.app.focus, "pw")
        g.keys(text="secret12")
        g.shot("wifi_password")
        g.keys("enter")
        g.settle()
        self.assertEqual(g.app.screen.state, "save")
        self.assertIn(("connect", "TripleRe-Office", "secret12"), s.calls)
        g.shot("wifi_save")
        g.keys("enter")  # focus is on "Save network"
        g.settle()
        self.assertIn("save-wifi", s.calls)
        self.assertIn(("licence", True), s.calls)
        self.assertEqual(g.screen(), "JobScreen")
        self.assertTrue(g.app.net["online"])
        g.keys(text="Vodafone Egypt")
        g.shot("job")
        g.keys("enter", "enter", text=None)  # next field, next field
        g.keys("enter")  # continue
        self.assertEqual(s.saved_job["client_name"], "Vodafone Egypt")
        self.assertEqual(s.saved_job["technician_name"], "Ahmed")
        g.settle()
        self.assertEqual(g.screen(), "DisksScreen")
        # internal disks pre-selected, the USB disk not
        self.assertEqual(g.app.screen.selected, {"nvme0n1", "sda"})
        g.shot("disks")

        g.click("erase")
        self.assertEqual(g.screen(), "ConfirmScreen")
        self.assertEqual(g.app.focus, "cancel", "Enter on the confirm screen must not erase by accident")
        g.shot("confirm")
        g.click("go")
        self.assertEqual(g.screen(), "ProgressScreen")
        self.assertEqual(s.calls[-1], ("wipe", ["nvme0n1", "sda"], "recommended"))
        s.job.advance(0.42)
        g.settle(5)
        g.shot("progress")

        s.job.finish()
        g.settle(1)
        self.assertEqual(g.screen(), "ReportsScreen")
        g.settle()
        self.assertIn("save-reports", s.calls)
        self.assertEqual(s.calls[-1], ("upload", ["/nwipe_log_20261117-101010.txt"]))
        self.assertTrue(g.app.screen.uploaded)
        g.shot("reports_uploaded")
        self.assertEqual(g.app.focus, "poweroff")
        g.keys("enter")
        self.assertIn("poweroff", s.calls)

    def test_offline_failed_disk_and_keyboard_only(self):
        s = FakeSystem(online=False, wifi=False, outcome={"nvme0n1": False})
        g = GuiHarness(self, s, size=(1366, 768))
        g.settle()
        self.assertEqual(g.app.screen.state, "nowifi")
        g.shot("no_network")
        g.settle(7)  # continues by itself
        g.settle()
        self.assertIn(("licence", False), s.calls)
        self.assertEqual(g.screen(), "JobScreen")
        g.keys("tab", "tab", "tab", "enter")  # to the Continue button
        g.settle()
        self.assertEqual(g.screen(), "DisksScreen")
        # keyboard: untick the HDD (disk:1) with Space, switch method, erase
        g.app.focus = "disk:1"
        g.keys("tab")  # focus moves on
        self.assertEqual(g.app.focus, "disk:2")
        g.app.focus = "disk:1"
        g.inputs.queue.append(Key("char", " "))
        g.settle()
        self.assertEqual(g.app.screen.selected, {"nvme0n1"})
        g.shot("disks_one")
        g.click("erase")
        g.keys("tab")  # cancel -> go
        self.assertEqual(g.app.focus, "go")
        g.keys("enter")
        self.assertEqual(g.screen(), "ProgressScreen")
        s.job.finish()
        g.settle(1)
        g.settle()
        self.assertEqual(g.screen(), "ReportsScreen")
        self.assertFalse(g.app.screen.uploaded)
        self.assertNotIn("upload", [c[0] if isinstance(c, tuple) else c for c in s.calls],
                         "offline: no upload attempt")
        g.shot("reports_failed_offline")
        g.click("more")
        g.settle()
        self.assertEqual(g.screen(), "DisksScreen")

    def test_licence_missing_blocks_wipe(self):
        s = FakeSystem(online=True, licence="missing")
        g = GuiHarness(self, s)
        g.settle()
        g.settle(3)
        g.settle()
        self.assertEqual(g.screen(), "LicenceScreen")
        g.shot("licence_missing")
        self.assertEqual(g.app.focus, "retry")
        s.licence_state = "valid"
        g.keys("enter")
        g.settle()
        self.assertEqual(g.screen(), "JobScreen")

    def test_classic_screen_exit_and_stop(self):
        s = FakeSystem(online=True)
        g = GuiHarness(self, s, size=(1920, 1080))
        g.settle()
        g.settle(3)
        g.settle()
        g.click("continue")  # job screen
        g.settle()
        self.assertEqual(g.screen(), "DisksScreen")
        g.click("method:overwrite")
        g.click("erase")
        g.click("go")
        self.assertEqual(s.calls[-1][2], "overwrite")
        g.click("stop")
        self.assertEqual(g.app.focus, "keep")
        g.shot("stop_confirm_1080p")
        g.click("stopnow")
        self.assertTrue(s.job.cancelled)
        s.job.finish()
        g.settle(1)
        g.settle()
        g.click("more")
        g.settle()
        g.click("classic")
        self.assertEqual(g.app.exit_code, appmod.EXIT_CLASSIC)

    def test_no_disks_and_long_names(self):
        s = FakeSystem(online=True, disks=[])
        g = GuiHarness(self, s, size=(1024, 768))
        g.settle()
        g.settle(3)
        g.settle()
        g.click("continue")
        g.settle()
        self.assertEqual(g.screen(), "DisksScreen")
        self.assertIsNone(dict(g.app.zones).get("erase"), "erase must be disabled without disks")
        g.shot("no_disks_1024")
        s.disks = [Disk(f"sd{c}", 10 ** 12, "Very Long Model Name Of A Hard Disk Drive That Goes On " * 2, "SN" * 20,
                        "HDD", False) for c in "abcdefg"]
        g.click("rescan")
        g.settle()
        self.assertEqual(len(g.app.screen.disks), 7)
        g.app.focus = "disk:0"
        for _ in range(6):
            g.keys("down")
        self.assertEqual(g.app.focus, "disk:6", "arrows must reach disks scrolled out of view")
        self.assertEqual(g.app.screen.scroll, 2)
        g.keys("char" if False else "up")
        g.inputs.queue.append(Key("char", " "))  # untick disk 5
        g.settle()
        self.assertNotIn("sdf", g.app.screen.selected)
        g.shot("many_disks_scrolled")


if __name__ == "__main__":
    unittest.main()


class FramebufferWriteTest(unittest.TestCase):
    """Pixels reach /dev/fb0 through write() (KMS drivers only refresh written ranges)."""

    def _display(self, path, width, height, stride):
        from triplere_gui.display import FramebufferDisplay

        d = FramebufferDisplay.__new__(FramebufferDisplay)
        ImageDisplay.__bases__[0].__init__(d)
        d.width, d.height, d.stride, d.bytespp, d.rawmode = width, height, stride, 4, "BGRX"
        d.origin, d.use_write, d.tty_fd = 0, True, None
        d.fd = os.open(path, os.O_RDWR)
        d.mem = None
        return d

    def test_full_frame_and_region_with_padded_rows(self):
        import tempfile

        w, h, stride = 8, 4, 40  # 8 px * 4 bytes = 32, plus 8 bytes of row padding
        with tempfile.NamedTemporaryFile() as tmp:
            tmp.write(b"\xee" * stride * h)
            tmp.flush()
            d = self._display(tmp.name, w, h, stride)
            try:
                d.present(Image.new("RGB", (w, h), (10, 20, 30)))
                d._write_image(2, 1, Image.new("RGB", (3, 2), (200, 100, 50)))
            finally:
                os.close(d.fd)
            with open(tmp.name, "rb") as f:
                buf = f.read()
        self.assertTrue(d.use_write)
        for y in range(h):
            line = buf[y * stride:(y + 1) * stride]
            self.assertEqual(line[32:], b"\xee" * 8, "row padding must be left alone")
            for x in range(w):
                px = line[x * 4:x * 4 + 3]
                inside = 2 <= x < 5 and 1 <= y < 3
                self.assertEqual(px, bytes((50, 100, 200)) if inside else bytes((30, 20, 10)), (x, y))
