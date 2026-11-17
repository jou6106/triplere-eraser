"""Integration test on Linux (run as root by CI, on a throw-away machine).

What is real here: the patched nwipe 0.43.1, ShredOS' own archive_log.sh and
find_shredos_boot_disc.sh (after apply.sh), the Triple Re scripts installed in /usr/bin
exactly as in the image, a FAT32 "USB drive" with boot/version.txt, loop-device disks, and
the graphical screens' wipe engine (triplere_gui.system). Only the ERP is a mock.

    sudo -E python3 -m unittest -v tests/integration/test_linux.py
env: TRIPLERE_NWIPE=<built nwipe>  SHREDOS_TREE=<shredos tree after apply.sh>  OUT=<artifact dir>
"""

import glob
import json
import os
import re
import shutil
import subprocess
import sys
import time
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", ".."))
sys.path.insert(0, os.path.join(REPO, "overlay", "usr", "lib", "triplere"))
os.environ.setdefault("TRIPLERE_PROGRESS_INTERVAL", "1")

from triplere_gui import system  # noqa: E402

NWIPE = os.environ["TRIPLERE_NWIPE"]
SHREDOS = os.environ["SHREDOS_TREE"]
OUT = os.environ.get("OUT", "/tmp/triplere-it")
PORT = 8099
TOKEN = "tre_integration_test"
RECORD = "/tmp/triplere_mock_erp.jsonl"
MNT = "/mnt/triplere-usb"
FORBIDDEN = re.compile(r"nwipe|shredos|partialvolume|martijnvanbrummelen", re.I)


def sh(cmd, check=True, **kw):
    print("+", cmd, flush=True)
    return subprocess.run(cmd, shell=True, check=check, text=True, capture_output=True, **kw)


def zeros(dev):
    """True when the whole block device reads back as zeros."""
    size = int(sh(f"blockdev --getsize64 {dev}").stdout)
    return sh(f"cmp -n {size} {dev} /dev/zero", check=False).returncode == 0


class LinuxIntegration(unittest.TestCase):
    loops = []

    @classmethod
    def setUpClass(cls):
        assert os.geteuid() == 0, "run as root"
        os.makedirs(OUT, exist_ok=True)
        fs = os.path.join(SHREDOS, "board", "shredos", "fsoverlay")
        version = open(os.path.join(fs, "etc", "shredos", "version.txt")).read().strip()
        # the image's files, where the image has them
        for d in ("/etc/shredos", "/etc/nwipe", "/etc/triplere", "/usr/lib/triplere"):
            os.makedirs(d, exist_ok=True)
        shutil.copy(os.path.join(fs, "etc", "shredos", "version.txt"), "/etc/shredos/version.txt")
        for f in glob.glob(os.path.join(fs, "etc", "nwipe", "*")):
            shutil.copy(f, "/etc/nwipe/")
        for f in ("archive_log.sh", "find_shredos_boot_disc.sh") + tuple(
                os.path.basename(p) for p in glob.glob(os.path.join(fs, "usr", "bin", "triplere_*"))):
            shutil.copy(os.path.join(fs, "usr", "bin", f), "/usr/bin/" + f)
            os.chmod("/usr/bin/" + f, 0o755)
        shutil.copytree(os.path.join(fs, "usr", "lib", "triplere", "triplere_gui"),
                        "/usr/lib/triplere/triplere_gui", dirs_exist_ok=True)
        for f in glob.glob("/nwipe_*") + glob.glob("/sent/nwipe_*") + [RECORD, "/tmp/triplere_uploaded.list"]:
            if os.path.isfile(f):
                os.remove(f)

        # the Triple Re USB drive: msdos label, one FAT32 partition, boot/version.txt
        sh("truncate -s 300M /tmp/usb.img && printf 'label: dos\\n,,c\\n' | sfdisk /tmp/usb.img")
        cls.usb = sh("losetup -fP --show /tmp/usb.img").stdout.strip()
        cls.loops.append(cls.usb)
        time.sleep(1)
        sh(f"mkfs.vfat -F 32 -n TRIPLERE {cls.usb}p1")
        os.makedirs(MNT, exist_ok=True)
        sh(f"mount {cls.usb}p1 {MNT} && mkdir -p {MNT}/boot {MNT}/etc/triplere {MNT}/etc/nwipe")
        with open(f"{MNT}/boot/version.txt", "w") as f:
            f.write(version + "\n")
        with open(f"{MNT}/etc/triplere/upload.conf", "w") as f:
            f.write(f'ERP_URL="http://127.0.0.1:{PORT}/api/erasure/upload"\nUPLOAD_TOKEN="{TOKEN}"\n')
        sh(f"umount {MNT}")

        # two disks to erase, full of random data
        cls.disks = []
        for i, size in enumerate(("3G", "2G")):
            img = f"/tmp/disk{i}.img"
            sh(f"truncate -s {size} {img}")
            dev = sh(f"losetup -f --show {img}").stdout.strip()
            cls.loops.append(dev)
            sh(f"dd if=/dev/urandom of={dev} bs=4M count=16 oflag=direct status=none")
            cls.disks.append(dev)

        cls.erp = subprocess.Popen([sys.executable, os.path.join(HERE, "mock_erp.py"), str(PORT), TOKEN, RECORD])
        time.sleep(1)

    @classmethod
    def tearDownClass(cls):
        cls.erp.terminate()
        sh(f"umount {MNT}", check=False)
        for dev in cls.loops:
            sh(f"losetup -d {dev}", check=False)
        for f in glob.glob("/nwipe_*") + glob.glob("/sent/*") + glob.glob("/dmesg_*") + glob.glob("/tmp/triplere_*"):
            if os.path.isfile(f):
                shutil.copy(f, OUT)

    # ------------------------------------------------------------------ 1
    def test_1_sanitize_mode_never_overwrites(self):
        """--sanitize on a disk without firmware erase: reported unsupported, data untouched."""
        dev = self.disks[1]
        before = sh(f"dd if={dev} bs=1M count=8 status=none | sha256sum").stdout
        log = "/tmp/sanitize_only.txt"
        r = sh(f"{NWIPE} --nogui --autonuke --nowait --sanitize=auto --logfile={log} --PDFreportpath=/tmp {dev}",
               check=False)
        text = open(log).read()
        shutil.copy(log, OUT)
        self.assertEqual(r.returncode, 1, r.stdout + r.stderr)
        self.assertIn(f"{dev}: SANITIZE unsupported on this device", text)
        self.assertNotIn("Total Throughput", text)
        self.assertEqual(before, sh(f"dd if={dev} bs=1M count=8 status=none | sha256sum").stdout,
                         "sanitize mode must never write to the disk")
        r = sh(f"{NWIPE} --sanitize=auto {dev}", check=False)
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("--sanitize must be used with --nogui and --autonuke", r.stderr)

    # ------------------------------------------------------------------ 2
    def test_2_gui_engine_erases_saves_and_uploads(self):
        # hardware inventory, as at boot
        sh("TRIPLERE_OUT_DIR= /usr/bin/triplere_hw_inventory.sh")
        # boot: the launcher reads the USB drive (upload.conf -> /etc/triplere)
        sh("cd / && /usr/bin/archive_log.sh -r")
        self.assertTrue(os.path.isfile("/etc/triplere/upload.conf"), "upload.conf not read from the USB drive")

        disks = [system.Disk(os.path.basename(self.disks[0]), 3 << 30, "Loop SSD", "SN-SSD-1", "SSD", False),
                 system.Disk(os.path.basename(self.disks[1]), 2 << 30, "Loop HDD", "SN-HDD-2", "HDD", False)]
        job = system.WipeJob(disks, "recommended")
        self.assertEqual(job.states[disks[0].name].mode, "sanitize")
        self.assertEqual(job.states[disks[1].name].mode, "overwrite")
        job.start()
        seen = set()
        deadline = time.time() + 900
        while not job.done and time.time() < deadline:
            for st in job.states.values():
                if 0 < st.fraction < 1:
                    seen.add((st.disk.name, st.stage.split(" ")[0]))
            time.sleep(0.2)
        self.assertTrue(job.done, "wipe did not finish in 15 minutes")
        print("progress seen:", sorted(seen), flush=True)
        for st in job.states.values():
            self.assertEqual(st.result, "erased", f"{st.disk.name}: {st.result} {st.detail}")
        self.assertTrue(job.states[disks[0].name].fell_back, "SSD without firmware erase must fall back")
        self.assertTrue(any(stage == "Writing" for _n, stage in seen), f"no write progress parsed: {seen}")
        # The verify pass of these small disks can be over between two progress requests, so the
        # verify line (same format, real nwipe wording) is checked directly instead of by timing.
        probe = system.WipeJob([disks[1]], "overwrite")
        probe._parse_overwrite(f"[2026/11/17 10:00:00]    info: /dev/{disks[1].name}: 63.50%, round 1 of 1, "
                               "pass 2 of 2, eta 00:01:10, [verifying]>")
        st = probe.states[disks[1].name]
        self.assertEqual((st.stage, round(st.fraction, 3), st.eta), ("Verifying (pass 2 of 2)", 0.635, "0:01:10"))
        for dev in self.disks:
            self.assertTrue(zeros(dev), f"{dev} is not all zeros after the erase")

        # PDF reports: one per disk, Triple Re name, no tool name anywhere
        pdfs = sorted(glob.glob("/nwipe_report_*.pdf"))
        self.assertEqual(len(pdfs), 2, pdfs)
        for pdf in pdfs:
            text = sh(f"pdftotext -layout '{pdf}' -").stdout
            info = sh(f"pdfinfo '{pdf}'").stdout
            self.assertIn("Triple Re", text)
            self.assertIn("Disk Erasure by Triple Re Eraser", text)
            self.assertIn("ERASED", text)
            self.assertIsNone(FORBIDDEN.search(text), f"tool name in {pdf}: {FORBIDDEN.search(text)}")
            self.assertIsNone(FORBIDDEN.search(info), f"tool name in PDF info: {info}")
            self.assertNotRegex(text.lower(), r"copyright \(c\)")
            sh(f"pdftoppm -r 50 -png -f 1 -l 1 '{pdf}' '{OUT}/{os.path.basename(pdf)}'")
        for pdf in glob.glob("/nwipe_system_report_*.pdf"):
            self.assertIsNone(FORBIDDEN.search(sh(f"pdftotext '{pdf}' -").stdout + sh(f"pdfinfo '{pdf}'").stdout))

        # save on the USB drive (ShredOS' archive_log.sh moves the files to /sent)
        sysm = system.RealSystem()
        sysm.save_job({"client_name": "Integration Customer", "technician_name": "CI", "work_order": "WO-42"})
        self.assertTrue(sysm.save_reports())
        self.assertEqual(glob.glob("/nwipe_report_*.pdf"), [], "archive_log.sh should have moved the PDFs to /sent")
        sh(f"mount {self.usb}p1 {MNT}")
        try:
            on_usb = os.listdir(MNT)
            for pdf in pdfs:
                self.assertIn(os.path.basename(pdf), on_usb)
                self.assertGreater(os.path.getsize(os.path.join(MNT, os.path.basename(pdf))), 1000)
            for log in job.logs:
                self.assertIn(os.path.basename(log), on_usb)
            self.assertTrue(os.path.isfile(f"{MNT}/etc/triplere/job.conf"), "job details not kept on the USB drive")
        finally:
            sh(f"umount {MNT}")

        # upload: the files are in /sent now (the old uploader looked in / only)
        ok, reason = sysm.upload(job.logs)
        self.assertTrue(ok, reason)
        reqs = [json.loads(l) for l in open(RECORD)]
        self.assertEqual(len(reqs), 1, reqs)
        req = reqs[0]
        self.assertEqual(req["status"], 201)
        files = {f["field"]: f for f in req["files"] if f["field"] != "pdf_files[]"}
        self.assertIn("Total Throughput", open([l for l in glob.glob("/sent/nwipe_log_[0-9]*.txt")
                                                 if os.path.basename(l) == files["log_file"]["filename"]][0]).read())
        self.assertTrue(files["inventory_file"]["filename"].startswith("nwipe_log_hwinventory_"))
        sent_pdfs = sorted(f["filename"] for f in req["files"] if f["field"] == "pdf_files[]")
        self.assertEqual(sent_pdfs, sorted(os.path.basename(p) for p in pdfs))
        self.assertEqual(req["fields"], {"client_name": "Integration Customer", "technician_name": "CI",
                                         "work_order": "WO-42"})
        # a second run does not send the same session again
        ok, _ = sysm.upload(job.logs)
        self.assertTrue(ok)
        self.assertEqual(len(open(RECORD).readlines()), 1)

    # ------------------------------------------------------------------ 3
    def test_3_upload_rejected_and_offline_are_reported(self):
        good = open("/etc/triplere/upload.conf").read()
        try:
            with open("/etc/triplere/upload.conf", "w") as f:
                f.write(good.replace(TOKEN, "tre_wrong"))
            if os.path.exists("/tmp/triplere_uploaded.list"):
                os.remove("/tmp/triplere_uploaded.list")
            logs = [os.path.join("/", os.path.basename(p)) for p in glob.glob("/sent/nwipe_log_[0-9]*.txt")]
            ok, reason = system.RealSystem().upload(logs)
            self.assertFalse(ok)
            self.assertIn("rejected", reason.lower())
            with open("/etc/triplere/upload.conf", "w") as f:
                f.write(good.replace(str(PORT), "9"))  # nothing listens there
            env = dict(os.environ, TRIPLERE_ATTEMPTS="2", TRIPLERE_RETRY_SECONDS="1")
            subprocess.run(["/usr/bin/triplere_uploader.sh"], env=env, timeout=120)
            status = open("/nwipe_log_upload_status.txt").read()
            self.assertIn("No connection to the ERP", status)
        finally:
            with open("/etc/triplere/upload.conf", "w") as f:
                f.write(good)

    # ------------------------------------------------------------------ 4
    def test_4_licence_check(self):
        d = "/tmp/lic"
        os.makedirs(d, exist_ok=True)
        sh(f"openssl ecparam -name prime256v1 -genkey -noout -out {d}/key.pem && "
           f"openssl ec -in {d}/key.pem -pubout -out {d}/pub.pem")

        def licence(lid, issued, expires, tamper=False):
            data = f"triplere-license-v1|{lid}|{issued}|{expires}"
            sig = sh(f"printf '%s' '{data}' | openssl dgst -sha256 -sign {d}/key.pem | openssl base64 -A").stdout
            with open(f"{d}/upload.conf", "w") as f:
                f.write(f'LICENSE_ID="{lid + (1 if tamper else 0)}"\nLICENSE_ISSUED="{issued}"\n'
                        f'LICENSE_EXPIRES="{expires}"\nLICENSE_SIG="{sig}"\n')
            env = dict(os.environ, LICENSE_CONF=f"{d}/upload.conf", LICENSE_PUBKEY=f"{d}/pub.pem")
            return subprocess.run(["/usr/bin/triplere_license.sh", "state"], env=env, capture_output=True,
                                  text=True).stdout.strip()

        self.assertEqual(licence(7, "2026-01-01", "2099-01-01"), "valid")
        self.assertEqual(licence(7, "2026-01-01", "2099-01-01", tamper=True), "invalid")
        self.assertEqual(licence(7, "2020-01-01", "2020-02-01"), "expired")
        os.remove(f"{d}/upload.conf")
        env = dict(os.environ, LICENSE_CONF=f"{d}/upload.conf", LICENSE_PUBKEY=f"{d}/pub.pem")
        self.assertEqual(subprocess.run(["/usr/bin/triplere_license.sh", "state"], env=env, capture_output=True,
                                        text=True).stdout.strip(), "missing")

    def test_5_network_helper(self):
        out = sh("/usr/bin/triplere_net.sh status").stdout
        self.assertIn("online=1", out)
        self.assertIn("wired=1", out)


if __name__ == "__main__":
    unittest.main()
