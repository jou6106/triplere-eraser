"""Entry point: python3 -m triplere_gui (started by /usr/bin/triplere_gui)."""

import os
import sys
import time
import traceback

ERROR_LOG = os.environ.get("TRIPLERE_GUI_ERROR_LOG", "/nwipe_log_gui_error.txt")
LOGO_PATHS = ("/usr/share/triplere/logo.jpg", "/etc/nwipe/logo.jpg")
EXIT_NO_GUI = 1


def load_logo():
    from PIL import Image

    for p in LOGO_PATHS:
        try:
            return Image.open(p).convert("RGB")
        except Exception:
            continue
    return None


def main():
    from .app import App
    from .display import FramebufferDisplay
    from .inputdev import InputManager
    from .system import RealSystem

    tty = os.ttyname(0) if os.isatty(0) else None
    display = FramebufferDisplay(os.environ.get("TRIPLERE_FB", "/dev/fb0"), tty_path=tty)
    inputs = None
    try:
        inputs = InputManager(display.width, display.height)
        if not inputs.devices:
            time.sleep(3)
            inputs.rescan()
        if not any(d.useful for d in inputs.devices.values()):
            raise RuntimeError("no keyboard, mouse or touchpad found")
        return App(display, inputs, RealSystem(), load_logo()).run()
    finally:
        if inputs:
            inputs.close()
        display.close()


if __name__ == "__main__":
    try:
        code = main()
    except Exception:
        try:
            with open(ERROR_LOG, "a") as f:
                f.write(time.strftime("[%Y/%m/%d %H:%M:%S] graphical screens stopped:\n"))
                traceback.print_exc(file=f)
        except OSError:
            pass
        traceback.print_exc()
        code = EXIT_NO_GUI
    sys.exit(code)
