"""Everything the graphical screens do to the machine: network, licence, disks, wipe, reports.

The network and licence steps call the same shell scripts as the text screens
(triplere_net.sh, triplere_license.sh), so both paths behave the same. The wipe itself is
nwipe, unchanged, started with --nogui; the GUI only follows its log.
"""

import glob
import os
import re
import signal
import subprocess
import threading
import time
from dataclasses import dataclass, field

BIN = os.environ.get("TRIPLERE_BIN", "/usr/bin")
WORK_DIR = os.environ.get("TRIPLERE_WORK_DIR", "/")  # nwipe logs + PDFs (the launcher's directory)
CONF_DIR = os.environ.get("TRIPLERE_CONF_DIR", "/etc/triplere")
JOB_CONF = os.path.join(CONF_DIR, "job.conf")
NWIPE = os.environ.get("TRIPLERE_NWIPE", "/usr/bin/nwipe")
SYS_BLOCK = os.environ.get("TRIPLERE_SYS_BLOCK", "/sys/block")

# How often the eraser is asked (SIGUSR1) to log its progress, in seconds.
PROGRESS_INTERVAL = float(os.environ.get("TRIPLERE_PROGRESS_INTERVAL", "5"))

SKIP_PREFIXES = ("loop", "ram", "zram", "sr", "fd", "dm-", "md", "nbd", "mtdblock")


def _read(path, default=""):
    try:
        with open(path, "rb") as f:
            return f.read().decode("utf-8", "replace").strip()
    except OSError:
        return default


def _run(args, timeout=None, input_text=None, env=None):
    try:
        p = subprocess.run(args, input=input_text, capture_output=True, text=True, timeout=timeout, env=env)
        return p.returncode, p.stdout
    except (OSError, subprocess.TimeoutExpired):
        return 127, ""


def human_size(n):
    for unit, div in (("TB", 1e12), ("GB", 1e9), ("MB", 1e6)):
        if n >= div:
            v = n / div
            return f"{v:.0f} {unit}" if v >= 10 else f"{v:.1f} {unit}"
    return f"{n} B"


@dataclass
class Disk:
    name: str  # sda, nvme0n1
    size: int
    model: str
    serial: str
    kind: str  # NVMe, SSD, HDD, USB, eMMC
    usb: bool

    @property
    def path(self):
        return "/dev/" + self.name

    @property
    def firmware_erase(self):
        """Recommended method: the drive's own sanitize for internal flash drives."""
        return self.kind in ("NVMe", "SSD")

    @property
    def label(self):
        return f"{self.model or 'Unknown model'}"


# ---------------------------------------------------------------------------- disks
def _vpd_serial(dev):
    raw = b""
    try:
        with open(f"{SYS_BLOCK}/{dev}/device/vpd_pg80", "rb") as f:
            raw = f.read()
    except OSError:
        return ""
    return raw[4:].decode("ascii", "ignore").strip(" \x00")


def boot_disks():
    """The Triple Re USB drive and anything mounted are never offered for wiping."""
    names = set()
    boot = _read(os.path.join(WORK_DIR, "boot_device.txt"))
    if boot:
        names.add(os.path.basename(boot))
    mounts = _read("/proc/mounts")
    for line in mounts.splitlines():
        src = line.split(" ", 1)[0]
        if src.startswith("/dev/"):
            base = os.path.basename(src)
            m = re.match(r"^(nvme\d+n\d+|mmcblk\d+)p\d+$", base) or re.match(r"^([a-z]+)\d+$", base)
            names.add(m.group(1) if m else base)
    return names


def list_disks():
    excluded = boot_disks()
    disks = []
    for path in sorted(glob.glob(f"{SYS_BLOCK}/*")):
        name = os.path.basename(path)
        if name.startswith(SKIP_PREFIXES) or re.search(r"(boot\d+|rpmb)$", name) or name in excluded:
            continue
        try:
            size = int(_read(f"{path}/size", "0")) * 512
        except ValueError:
            size = 0
        if size <= 0:
            continue
        real = os.path.realpath(path)
        usb = "/usb" in real
        if name.startswith("nvme"):
            model = _read(f"{path}/device/model")
            serial = _read(f"{path}/device/serial")
            kind = "NVMe"
        elif name.startswith("mmcblk"):
            model = _read(f"{path}/device/name")
            serial = _read(f"{path}/device/serial")
            kind = "eMMC"
        else:
            vendor = _read(f"{path}/device/vendor")
            model = _read(f"{path}/device/model")
            if vendor and vendor.upper() not in ("ATA", "") and not model.lower().startswith(vendor.lower()):
                model = f"{vendor} {model}"
            serial = _read(f"{path}/device/serial") or _vpd_serial(name)
            rotational = _read(f"{path}/queue/rotational", "1") == "1"
            kind = "USB" if usb else ("HDD" if rotational else "SSD")
        disks.append(Disk(name, size, " ".join(model.split()), serial, kind, usb))
    return disks


# ---------------------------------------------------------------------------- wipe
METHODS = {
    # id: (label, nwipe arguments)
    "recommended": ("Recommended", None),
    "overwrite": ("Overwrite + verify", ["--method=zero", "--verify=last"]),
    "dod": ("3-pass overwrite + verify", ["--method=dodshort", "--verify=last"]),
}
OVERWRITE_DEFAULT = ["--method=zero", "--verify=last"]

PROGRESS_RE = re.compile(
    r"(/dev/\S+): (\d+(?:\.\d+)?)%, round (\d+) of (\d+), pass (\d+) of (\d+), eta (\d+):(\d+):(\d+), ?(.*)$")
SAN_PROGRESS_RE = re.compile(r"(/dev/\S+): SANITIZE progress (\d+)%")
SAN_OK_RE = re.compile(r"(/dev/\S+): SANITIZE action '([^']+)' was successful")
SAN_FAIL_RE = re.compile(r"(/dev/\S+): (?:SANITIZE action '[^']+' has failed|Sanitize command was rejected|"
                         r"Failed to open|Failed to read the sanitize|gave up reading)")
SAN_UNSUP_RE = re.compile(r"(/dev/\S+): SANITIZE (?:unsupported|not supported|not possible)")
FINISHED_RE = re.compile(r"Total Throughput|SANITIZE action '[^']+' was successful")
SUMMARY_RE = re.compile(r"^\s*!?\s*(\S+)\s+\|\s*(Erased|-FAILED-|UABORTED|INSANITY)\s*\|")


def _usr1_handled(pid):
    """True once the eraser has set up its signal thread (SIGUSR1 blocked, collected by sigwait).

    Before that, SIGUSR1 still has its default action and would KILL the eraser: it only
    sets the signal thread up after scanning the disks, which can take a while.
    """
    try:
        with open(f"/proc/{pid}/status") as f:
            for line in f:
                if line.startswith("SigBlk:"):
                    return bool(int(line.split()[1], 16) & (1 << (signal.SIGUSR1 - 1)))
    except (OSError, ValueError):
        pass
    return False


def _covers(path, name):
    """/dev/nvme0 (controller) covers nvme0n1; /dev/sda covers sda."""
    base = os.path.basename(path)
    return base == name or name.startswith(base + "n")


@dataclass
class DiskState:
    disk: Disk
    mode: str  # "sanitize" or "overwrite"
    stage: str = "Waiting"
    fraction: float = 0.0
    eta: str = ""
    result: str = ""  # "", "erased", "failed", "aborted"
    detail: str = ""
    fell_back: bool = False


@dataclass
class WipeJob:
    disks: list
    method: str = "recommended"
    states: dict = field(default_factory=dict)
    logs: list = field(default_factory=list)
    phase: str = "starting"  # starting, sanitize, overwrite, done
    started: float = field(default_factory=time.monotonic)
    finished: float = 0.0
    cancelled: bool = False
    proc: object = None
    error: str = ""

    def __post_init__(self):
        for d in self.disks:
            mode = "sanitize" if (self.method == "recommended" and d.firmware_erase) else "overwrite"
            self.states[d.name] = DiskState(d, mode)
        self.lock = threading.Lock()
        self.thread = threading.Thread(target=self._run, daemon=True)

    def start(self):
        self.thread.start()

    @property
    def done(self):
        return self.phase == "done"

    @property
    def can_cancel(self):
        return self.phase in ("starting", "overwrite") and not self.cancelled

    def cancel(self):
        self.cancelled = True
        p = self.proc
        if p and p.poll() is None and self.phase == "overwrite":
            try:
                p.send_signal(signal.SIGTERM)
            except OSError:
                pass

    # -- helpers
    def _logfile(self):
        while True:
            name = os.path.join(WORK_DIR, time.strftime("nwipe_log_%Y%m%d-%H%M%S.txt"))
            if not os.path.exists(name) and name not in self.logs:
                return name
            time.sleep(1.0)

    def _start_nwipe(self, extra, names):
        log = self._logfile()
        self.logs.append(log)
        out = open(os.path.join("/tmp" if os.path.isdir("/tmp") else WORK_DIR, "triplere_nwipe.out"), "ab")
        args = [NWIPE, "--nogui", "--autonuke", "--nowait", f"--logfile={log}", f"--PDFreportpath={WORK_DIR}"] \
            + extra + ["/dev/" + n for n in names]
        self.proc = subprocess.Popen(args, cwd=WORK_DIR, stdin=subprocess.DEVNULL, stdout=out, stderr=out,
                                     start_new_session=True)
        out.close()
        return log, self.proc

    def _follow(self, log, proc, parse_line, usr1):
        pos = 0
        last_usr1 = 0.0
        while True:
            alive = proc.poll() is None
            if alive and usr1 and time.monotonic() - last_usr1 > PROGRESS_INTERVAL and _usr1_handled(proc.pid):
                last_usr1 = time.monotonic()
                try:
                    proc.send_signal(signal.SIGUSR1)
                except OSError:
                    pass
            try:
                with open(log, "r", errors="replace") as f:
                    f.seek(pos)
                    chunk = f.read()
                    pos = f.tell()
            except OSError:
                chunk = ""
            for line in chunk.splitlines():
                with self.lock:
                    parse_line(line)
            if not alive:
                return proc.returncode
            time.sleep(0.5)

    # -- the wipe
    def _run(self):
        try:
            self._run_inner()
        except Exception as e:  # never leave the screen waiting forever
            self.error = str(e)
            with self.lock:
                for st in self.states.values():
                    if not st.result:
                        st.result = "failed"
                        st.detail = "Internal error: " + str(e)[:80]
        finally:
            self.finished = time.monotonic()
            self.phase = "done"

    def _run_inner(self):
        san = [n for n, st in self.states.items() if st.mode == "sanitize"]
        if san and not self.cancelled:
            self.phase = "sanitize"
            for n in san:
                self.states[n].stage = "Starting firmware erase"
            log, proc = self._start_nwipe(["--sanitize=auto"], san)
            self._follow(log, proc, self._parse_sanitize, usr1=False)
            with self.lock:
                for n in san:
                    st = self.states[n]
                    if st.result:
                        continue
                    if st.stage == "unsupported":
                        # The drive has no usable firmware erase (or it is frozen): overwrite it instead.
                        st.mode = "overwrite"
                        st.fell_back = True
                        st.stage = "Waiting"
                        st.fraction = 0.0
                    else:
                        st.result = "failed"
                        st.detail = st.detail or "The firmware erase did not finish"

        ow = [n for n, st in self.states.items() if st.mode == "overwrite" and not st.result]
        if ow and not self.cancelled:
            self.phase = "overwrite"
            for n in ow:
                self.states[n].stage = "Preparing"
            extra = METHODS.get(self.method, (None, None))[1] or OVERWRITE_DEFAULT
            log, proc = self._start_nwipe(list(extra), ow)
            rc = self._follow(log, proc, self._parse_overwrite, usr1=True)
            with self.lock:
                for n in ow:
                    st = self.states[n]
                    if not st.result:
                        st.result = "aborted" if self.cancelled else "failed"
                        st.detail = st.detail or ("Stopped" if self.cancelled else f"No result from the eraser (code {rc})")
        elif ow:
            for n in ow:
                self.states[n].result = "aborted"
                self.states[n].detail = "Stopped"

    def _state_for(self, path):
        for name, st in self.states.items():
            if _covers(path, name):
                yield st

    def _parse_sanitize(self, line):
        m = SAN_OK_RE.search(line)
        if m:
            for st in self._state_for(m.group(1)):
                if st.mode == "sanitize":
                    st.result, st.fraction, st.stage = "erased", 1.0, "Done"
                    st.detail = f"Firmware erase ({m.group(2)})"
            return
        m = SAN_UNSUP_RE.search(line)
        if m:
            for st in self._state_for(m.group(1)):
                if not st.result:
                    st.stage = "unsupported"
            return
        m = SAN_FAIL_RE.search(line)
        if m:
            for st in self._state_for(m.group(1)):
                if st.mode == "sanitize" and not st.result:
                    st.detail = "Firmware erase failed: " + line.split(": ", 2)[-1][:70]
            return
        m = SAN_PROGRESS_RE.search(line)
        if m:
            for st in self._state_for(m.group(1)):
                st.stage = "Firmware erase"
                st.fraction = int(m.group(2)) / 100.0
            return
        if "starting SANITIZE" in line:
            m2 = re.search(r"(/dev/\S+): starting SANITIZE", line)
            if m2:
                for st in self._state_for(m2.group(1)):
                    st.stage = "Firmware erase"

    def _parse_overwrite(self, line):
        m = PROGRESS_RE.search(line)
        if m:
            path, pct = m.group(1), float(m.group(2))
            rnd, rnds, ps, pss = (int(m.group(i)) for i in (3, 4, 5, 6))
            h, mi, s = (int(m.group(i)) for i in (7, 8, 9))
            status = m.group(10).strip("<>[] ")
            for st in self._state_for(path):
                st.fraction = pct / 100.0
                if "verif" in status:
                    st.stage = f"Verifying (pass {ps} of {pss})"
                elif "blank" in status:
                    st.stage = "Final zero pass"
                elif status:
                    st.stage = f"Writing (pass {ps} of {pss})"
                st.eta = f"{h:d}:{mi:02d}:{s:02d}" if (h or mi or s) else ""
            return
        m = SUMMARY_RE.search(line)
        if m:
            name, status = m.group(1), m.group(2)
            st = self.states.get(name)
            if st and st.mode == "overwrite":
                if status == "Erased":
                    st.result, st.fraction, st.stage = "erased", 1.0, "Done"
                    st.detail = "Overwritten and verified"
                elif status == "UABORTED":
                    st.result, st.detail = "aborted", "Stopped by the technician"
                else:
                    st.result, st.detail = "failed", "Erase failed - see the report"
            return
        if "Device geometry" in line or "Using direct I/O" in line or "Using cached I/O" in line:
            m2 = re.search(r"(/dev/\S+?)[:']", line)
            if m2:
                for st in self._state_for(m2.group(1)):
                    if st.stage in ("Preparing", "Waiting"):
                        st.stage = "Starting"


# ---------------------------------------------------------------------------- the machine
class RealSystem:
    def __init__(self):
        self.last_upload = ""

    # -- network (same code as the text screens)
    def net_status(self):
        rc, out = _run([f"{BIN}/triplere_net.sh", "status"], timeout=10)
        info = dict(line.split("=", 1) for line in out.splitlines() if "=" in line)
        return {"online": info.get("online") == "1", "wifi": bool(info.get("wifi")), "ssid": info.get("ssid", ""),
                "wired": info.get("wired") == "1"}

    def net_connect_saved(self):
        rc, _ = _run([f"{BIN}/triplere_net.sh", "connect-saved"], timeout=90)
        return rc == 0

    def has_saved_wifi(self):
        return os.path.getsize(os.path.join(CONF_DIR, "wifi.conf")) > 0 if os.path.exists(
            os.path.join(CONF_DIR, "wifi.conf")) else False

    def wifi_scan(self):
        rc, out = _run([f"{BIN}/triplere_net.sh", "scan"], timeout=40)
        nets = []
        for line in out.splitlines():
            parts = line.split("\t", 2)
            if len(parts) == 3:
                try:
                    nets.append((int(parts[0]), parts[1] == "1", parts[2]))
                except ValueError:
                    pass
        return nets

    def wifi_connect(self, ssid, password):
        rc, out = _run([f"{BIN}/triplere_net.sh", "connect", ssid], timeout=90, input_text=password + "\n")
        if rc == 3:
            return "badpass"
        return "ok" if rc == 0 else "fail"

    def wifi_save_last(self):
        _run([f"{BIN}/triplere_net.sh", "save-last"], timeout=10)

    def sync_clock(self):
        _run([f"{BIN}/triplere_net.sh", "sync-clock"], timeout=25)

    # -- licence
    def licence(self, online):
        disabled = False
        if online:
            rc, _ = _run([f"{BIN}/triplere_license.sh", "renew"], timeout=45)
            if rc in (0, 2):
                self.save_reports()  # keeps the renewed / removed licence on the USB drive
            disabled = rc == 2
        rc, out = _run([f"{BIN}/triplere_license.sh", "state"], timeout=15)
        state = out.strip() or "invalid"
        if disabled and state != "valid":
            return "disabled"
        return state

    # -- job details
    def load_job(self):
        job = {"client_name": "", "technician_name": "", "work_order": ""}
        for line in _read(JOB_CONF).splitlines():
            m = re.match(r'^([A-Z_]+)="(.*)"$', line)
            if m and m.group(1).lower() in job:
                job[m.group(1).lower()] = m.group(2)
        return job

    def save_job(self, job):
        os.makedirs(CONF_DIR, exist_ok=True)
        with open(JOB_CONF, "w") as f:
            f.write("# Written by the Triple Re graphical screens; sent with every upload.\n")
            for k in ("client_name", "technician_name", "work_order"):
                v = re.sub(r'["$`\\\n\r]', "", job.get(k, ""))[:120]
                f.write(f'{k.upper()}="{v}"\n')

    # -- disks / wipe
    def list_disks(self):
        return list_disks()

    def start_wipe(self, disks, method):
        job = WipeJob(disks, method)
        job.start()
        return job

    # -- reports
    def save_reports(self):
        rc, _ = _run([f"{BIN}/archive_log.sh", "-w"], timeout=180)
        _run(["sync"], timeout=60)
        return rc == 0

    def upload(self, logs):
        """Uploads every finished session not uploaded yet. Returns (all_uploaded, message)."""
        status = os.path.join(WORK_DIR, "nwipe_log_upload_status.txt")
        _run([f"{BIN}/triplere_uploader.sh"], timeout=900)
        text = _read(status)
        # Only sessions that finished a wipe are uploaded (e.g. not a firmware erase that was
        # not available and fell back to an overwrite in a second session).
        names = []
        for log in logs:
            name = os.path.basename(log)
            content = _read(log) or _read(os.path.join(WORK_DIR, "sent", name))
            if FINISHED_RE.search(content):
                names.append(name)
        ok = bool(names)
        reason = ""
        for n in names:
            lines = [l for l in text.splitlines() if n in l and ("Uploaded to ERP" in l or "USB only" in l)]
            if not lines or "Uploaded to ERP" not in lines[-1]:
                ok = False
                if lines:
                    reason = lines[-1].split("] ", 1)[-1].split(" - ")[0]
        return ok, reason

    def power_off(self):
        _run(["sync"], timeout=60)
        subprocess.Popen(["poweroff"])

    def reboot(self):
        _run(["sync"], timeout=60)
        subprocess.Popen(["reboot"])
