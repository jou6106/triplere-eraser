"""Boots the built USB image in QEMU and checks the graphical screens on the real kernel.

    python3 smoke.py <image.img> <out-dir>

1. boots the image as a USB stick with an empty NVMe disk attached,
2. waits for the Triple Re screens (white header + Triple Re green) on the framebuffer,
3. checks the keyboard (Tab moves the focus) and the mouse (the pointer appears),
4. presses Power off on the licence screen (the image has no licence) and expects the VM to stop.
Screenshots of every step are saved in <out-dir>.
"""

import os
import socket
import subprocess
import sys
import time

from PIL import Image, ImageChops

IMG, OUT = sys.argv[1], sys.argv[2]
SOCK = "/tmp/triplere-qemu.sock"
GREEN = (15, 133, 64)


class Monitor:
    def __init__(self, path):
        for _ in range(100):
            try:
                self.s = socket.socket(socket.AF_UNIX)
                self.s.connect(path)
                break
            except OSError:
                time.sleep(0.2)
        else:
            raise RuntimeError("QEMU monitor not reachable")
        self.s.settimeout(5)
        self._read()

    def _read(self):
        data = b""
        try:
            while not data.endswith(b"(qemu) "):
                chunk = self.s.recv(65536)
                if not chunk:
                    break
                data += chunk
        except socket.timeout:
            pass
        return data.decode(errors="replace")

    def cmd(self, line):
        self.s.sendall(line.encode() + b"\n")
        return self._read()


def shot(mon, name):
    ppm = f"/tmp/{name}.ppm"
    mon.cmd(f"screendump {ppm}")
    for _ in range(20):
        if os.path.exists(ppm) and os.path.getsize(ppm) > 0:
            break
        time.sleep(0.2)
    time.sleep(0.3)
    img = Image.open(ppm).convert("RGB")
    img.save(os.path.join(OUT, name + ".png"))
    os.remove(ppm)
    return img


def looks_like_gui(img):
    w, h = img.size
    header = img.crop((0, 0, w, int(h * 0.08))).convert("L")
    white = sum(1 for v in header.getdata() if v > 245) / (header.width * header.height)
    small = img.resize((w // 4, h // 4))
    green = sum(1 for p in small.getdata() if all(abs(a - b) < 30 for a, b in zip(p, GREEN)))
    return white > 0.8 and green > 20, white, green


def changed(a, b):
    return ImageChops.difference(a, b).getbbox() is not None


def main():
    os.makedirs(OUT, exist_ok=True)
    subprocess.run(["qemu-img", "create", "-f", "raw", "/tmp/nvme.img", "1G"], check=True)
    kvm = os.access("/dev/kvm", os.R_OK | os.W_OK)
    args = ["qemu-system-x86_64", "-m", "3072", "-smp", "2",
            "-drive", f"file={IMG},format=raw,if=none,id=usb,snapshot=on",
            "-device", "qemu-xhci", "-device", "usb-storage,drive=usb,bootindex=0",
            "-drive", "file=/tmp/nvme.img,format=raw,if=none,id=nv",
            "-device", "nvme,serial=TRIPLERETEST,drive=nv",
            "-nic", "user,model=e1000",
            "-vga", "std", "-display", "none",
            "-monitor", f"unix:{SOCK},server,nowait", "-serial", f"file:{OUT}/serial.log"]
    if kvm:
        args[1:1] = ["-enable-kvm", "-cpu", "host"]
    print("kvm:", kvm, flush=True)
    qemu = subprocess.Popen(args)
    mon = Monitor(SOCK)
    try:
        deadline = time.time() + (600 if kvm else 1800)
        n = 0
        img = None
        while time.time() < deadline:
            time.sleep(10)
            n += 1
            img = shot(mon, f"boot_{n:03d}")
            ok, white, green = looks_like_gui(img)
            print(f"boot shot {n}: white={white:.2f} green={green}", flush=True)
            if ok:
                break
        else:
            raise SystemExit("FAIL: the graphical screens did not appear")
        print("PASS: graphical screens are on the framebuffer", flush=True)

        # wait until the licence screen is steady (network + licence checks finish)
        last = img
        for i in range(30):
            time.sleep(4)
            img = shot(mon, f"settle_{i:02d}")
            if not changed(img, last):
                break
            last = img
        steady = shot(mon, "steady")

        mon.cmd("sendkey tab")
        time.sleep(2)
        after_tab = shot(mon, "after_tab")
        if not changed(steady, after_tab):
            raise SystemExit("FAIL: Tab did not move the focus (keyboard input not reaching the GUI)")
        print("PASS: keyboard", flush=True)

        mon.cmd("mouse_move 40 30")
        time.sleep(2)
        after_mouse = shot(mon, "after_mouse")
        if not changed(after_tab, after_mouse):
            raise SystemExit("FAIL: the mouse pointer did not appear")
        print("PASS: mouse", flush=True)

        # Licence screen focus order: Power off, Connect to Wi-Fi, Retry (focus starts on Retry);
        # one Tab wrapped it to Power off.
        mon.cmd("sendkey ret")
        for _ in range(60):
            if qemu.poll() is not None:
                break
            time.sleep(2)
        if qemu.poll() is None:
            shot(mon, "after_poweroff")
            raise SystemExit("FAIL: Power off on the licence screen did not stop the machine")
        print("PASS: Power off", flush=True)
    finally:
        if qemu.poll() is None:
            qemu.kill()


if __name__ == "__main__":
    main()
