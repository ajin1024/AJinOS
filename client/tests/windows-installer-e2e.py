# Catch a setup that skips folder or reinstall choices, mishandles data, or cannot run Studio with bundled Node.js.
import ctypes
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import tempfile
import time

from playwright.sync_api import expect, sync_playwright
import win32con
import win32gui
import win32process

root = Path(__file__).resolve().parents[1]
installer = (Path(sys.argv[1]) if len(sys.argv) > 1 else root / "dist/AJinOS-Setup-x64.exe").resolve()


def free_port():
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


def wait_for(read, timeout=40, failure="Timed out waiting for the installed application"):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        result = read()
        if result:
            return result
        time.sleep(0.2)
    raise AssertionError(failure)


def install_from_wizard(setup, temp, install, *, prefilled_path=None, reset=None):
    env = {
        **os.environ, "USERPROFILE": str(temp / "Windows profile"),
        "ELECTRON_RUN_AS_NODE": "1", "STUDIO_HOME": str(temp / "wizard-home"),
        "STUDIO_DESKTOP_PROFILE": str(temp / "wizard-profile"), "STUDIO_WINDOW_HIDDEN": "1",
    }
    # Keep an old one-click setup under test inside the temporary directory as well.
    command = subprocess.list2cmdline([str(setup), "--no-desktop-shortcut"])
    if prefilled_path:
        command += " /D=" + str(prefilled_path)

    def control_text(hwnd):
        length = win32gui.SendMessage(hwnd, win32con.WM_GETTEXTLENGTH, 0, 0)
        value = ctypes.create_unicode_buffer(length + 1)
        win32gui.SendMessage(hwnd, win32con.WM_GETTEXT, len(value), ctypes.addressof(value))
        return value.value

    with subprocess.Popen(command, env=env, cwd=temp) as process:
        def find_control(class_name, matches):
            if process.poll() is not None:
                raise AssertionError("Setup exited before showing the expected wizard page")
            windows = []
            win32gui.EnumWindows(lambda hwnd, _: windows.append(hwnd), None)
            for window in windows:
                if win32process.GetWindowThreadProcessId(window)[1] != process.pid:
                    continue
                children = []
                win32gui.EnumChildWindows(window, lambda hwnd, _: children.append(hwnd), None)
                for child in children:
                    if (
                        win32gui.IsWindowVisible(child) and win32gui.IsWindowEnabled(child)
                        and win32gui.GetClassName(child) == class_name
                        and matches(child)
                    ):
                        return window, child
            return None

        def click_button(control_id=win32con.IDOK):
            window, button = wait_for(
                lambda: find_control("Button", lambda hwnd: win32gui.GetDlgCtrlID(hwnd) == control_id),
            )
            win32gui.PostMessage(window, win32con.WM_COMMAND, control_id, button)

        def data_option(label):
            return find_control("Button", lambda hwnd: control_text(hwnd) == label)

        def directory_control():
            return find_control("Edit", lambda hwnd: win32gui.GetDlgCtrlID(hwnd) == 1019)

        try:
            if reset is not None:
                _, keep = wait_for(
                    lambda: data_option("保留原有数据（推荐）"),
                    timeout=15, failure="Setup did not ask what to do with existing data",
                )
                assert win32gui.SendMessage(keep, win32con.BM_GETCHECK, 0, 0) == win32con.BST_CHECKED
                if reset:
                    _, clean = wait_for(lambda: data_option("备份原有数据并全新安装"))
                    win32gui.SendMessage(clean, win32con.BM_SETCHECK, win32con.BST_CHECKED, 0)
                    win32gui.SendMessage(keep, win32con.BM_SETCHECK, win32con.BST_UNCHECKED, 0)
                    click_button()
                    click_button(win32con.IDNO)
                    wait_for(lambda: data_option("备份原有数据并全新安装"))
                    assert (Path(env["USERPROFILE"]) / ".agent-autoloop-studio" / "history.txt").is_file()
                    click_button()
                    click_button(win32con.IDYES)
                else:
                    click_button()

            _, directory = wait_for(
                directory_control,
                failure="Setup did not show the installation folder page",
            )
            if reset is not None:
                assert control_text(directory) == str(install)
            win32gui.SendMessage(directory, win32con.WM_SETTEXT, 0, str(install))
            click_button()
            _, run_on_finish = wait_for(
                lambda: find_control("Button", lambda hwnd: (
                    win32gui.GetWindowLong(hwnd, win32con.GWL_STYLE) & 0xF
                ) == win32con.BS_AUTOCHECKBOX),
                timeout=120, failure="Setup did not reach the finish page",
            )
            win32gui.SendMessage(run_on_finish, win32con.BM_SETCHECK, win32con.BST_UNCHECKED, 0)
            click_button()
            assert process.wait(timeout=20) == 0
        finally:
            if process.poll() is None:
                process.kill()


def check_install_slot():
    import winreg
    key = r"Software\Microsoft\Windows\CurrentVersion\Uninstall"
    with winreg.OpenKey(winreg.HKEY_CURRENT_USER, key) as entries:
        for index in range(winreg.QueryInfoKey(entries)[0]):
            with winreg.OpenKey(entries, winreg.EnumKey(entries, index)) as entry:
                try:
                    name = winreg.QueryValueEx(entry, "DisplayName")[0]
                except FileNotFoundError:
                    continue
                names = ("AJinOS", "Autoloop Studio", "阿锦 Auto")
                if name in names or name.startswith(tuple(item + " " for item in names)):
                    raise RuntimeError("Use a Windows account without an existing AJinOS installation")


driver = """
const {spawn} = require('node:child_process');
const child = spawn(process.argv[1], [process.argv[2]], {stdio: ['ignore', 'inherit', 'inherit', 'ipc']});
child.once('exit', () => process.exit(0));
child.once('error', error => { console.error(error); process.exit(1); });
process.stdin.on('data', () => child.connected && child.send({type: 'studio-stop'}));
"""

check_install_slot()
with tempfile.TemporaryDirectory(prefix="studio-installed-e2e-") as directory:
    temp = Path(directory)
    prefilled_path = temp / "AJinOS"
    install = temp / "Studio 安装"
    home = temp / "data"
    launch = install / "AJinOS.exe"
    old_data = temp / "Windows profile" / ".agent-autoloop-studio"
    history = old_data / "history.txt"
    try:
        install_from_wizard(installer, temp, install, prefilled_path=prefilled_path)
        assert launch.is_file(), launch
        assert not (prefilled_path / launch.name).exists()
        old_data.mkdir(parents=True)
        history.write_text("previous data", encoding="utf-8")
        install_from_wizard(installer, temp, install, reset=False)
        assert history.read_text(encoding="utf-8") == "previous data"
        assert not list(old_data.parent.glob(".agent-autoloop-studio.backup-*"))
        license_file = install / "resources/app/LICENSE"
        license_text = license_file.read_bytes()
        license_file.write_bytes(b"must be replaced by silent setup")
        subprocess.run(
            subprocess.list2cmdline([str(installer), "/S", "--updated"]) + " /D=" + str(install),
            check=True, timeout=120,
            env={**os.environ, "USERPROFILE": str(old_data.parent)},
        )
        assert license_file.read_bytes() == license_text
        assert history.read_text(encoding="utf-8") == "previous data"
        install_from_wizard(installer, temp, install, reset=True)
        assert launch.is_file(), launch
        assert not old_data.exists()
        backups = list(old_data.parent.glob(".agent-autoloop-studio.backup-*"))
        assert len(backups) == 1
        assert (backups[0] / history.name).read_text(encoding="utf-8") == "previous data"
        bundled = install / "resources/node/node.exe"
        bundled_version = subprocess.check_output([str(bundled), "-p", "process.arch+' '+process.version"], text=True).strip()
        assert bundled_version.startswith("x64 v24."), bundled_version

        port, debug = free_port(), free_port()
        system = Path(os.environ["SystemRoot"])
        env = {key: value for key, value in os.environ.items() if not key.startswith("STUDIO_")}
        for key in ("NODE_OPTIONS", "ELECTRON_RUN_AS_NODE", "NPM_NODE_EXECPATH"):
            env.pop(key, None)
        env.update(
            PATH=os.pathsep.join(str(system / part) for part in ("System32", "", "System32/WindowsPowerShell/v1.0")),
            STUDIO_HOME=str(home), STUDIO_PORT=str(port), STUDIO_DESKTOP_PROFILE=str(temp / "profile"),
            STUDIO_WINDOW_HIDDEN="1",
        )
        process = subprocess.Popen(
            [shutil.which("node"), "-e", driver, str(launch), f"--remote-debugging-port={debug}"],
            env=env, cwd=temp, stdin=subprocess.PIPE, creationflags=subprocess.CREATE_NO_WINDOW,
        )
        try:
            with sync_playwright() as playwright:
                def connect():
                    try:
                        return playwright.chromium.connect_over_cdp(f"http://127.0.0.1:{debug}", timeout=1000)
                    except Exception:
                        return None

                browser = wait_for(connect)
                try:
                    context = browser.contexts[0]
                    page = context.pages[0] if context.pages else context.wait_for_event("page", timeout=30000)
                    origin = f"http://127.0.0.1:{port}"
                    page.wait_for_url(origin + "/", timeout=30000)
                    expect(page.get_by_role("heading", name="工作台", exact=True)).to_be_visible()
                    expect(page).to_have_title("AJinOS")

                    def state():
                        response = page.request.get(origin + "/api/state")
                        assert response.ok
                        return response.json()

                    offline = wait_for(lambda: (snapshot := state()) and not snapshot["connected"] and snapshot)
                    engine = page.request.get(origin + "/api/engine").json()
                    assert engine["node"] == bundled_version.split()[1]
                    assert offline["enginePid"] is None
                    config = page.request.get(origin + "/api/config").json()["value"]
                    assert config["defaultProject"] == "autoloop"
                    assert [(item["id"], item["name"]) for item in config["projects"]] == [("autoloop", "AJinOS")]
                    mcp = subprocess.run(
                        [str(bundled), str(install / "resources/app/client/studio-mcp.mjs"), "--project", str(home)],
                        input='{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"studio_overview"}}\n',
                        text=True, capture_output=True, check=True, timeout=15, env=env,
                    )
                    overview = json.loads(json.loads(mcp.stdout)["result"]["content"][0]["text"])
                    assert overview["defaultProject"] == "autoloop"
                    power = page.locator("#engine-power")
                    power.click()
                    initial = wait_for(lambda: (snapshot := state())["connected"] and snapshot)
                    engine = page.request.get(origin + "/api/engine").json()
                    assert initial["enginePid"] == engine["pid"]
                    page.locator("#open-versions").click()
                    expect(page.locator("#versions-body")).to_contain_text("Windows 安装版")
                    page.keyboard.press("Escape")

                    power.click()
                    stop = page.get_by_role("dialog", name="停止引擎")
                    stop.get_by_role("button", name="停止引擎", exact=True).click()
                    expect(power).to_have_accessible_name("启动引擎")
                    stopped = state()
                    assert stopped["engineStopped"] and not stopped["connected"] and stopped["enginePid"] is None
                    power.click()
                    expect(power).to_have_attribute("data-engine-state", "online", timeout=20000)
                    resumed = wait_for(lambda: (snapshot := state())["connected"] and snapshot)
                    assert resumed["enginePid"] != initial["enginePid"]

                    hub = json.loads((home / "config.json").read_text(encoding="utf-8"))["url"]
                finally:
                    browser.close()
            process.stdin.write(b"stop\n")
            process.stdin.flush()
            assert process.wait(timeout=20) == 0
            with socket.socket() as probe:
                assert probe.connect_ex(("127.0.0.1", int(hub.rsplit(":", 1)[1]))) != 0
        finally:
            if process.poll() is None:
                subprocess.run(["taskkill.exe", "/PID", str(process.pid), "/T", "/F"], capture_output=True)
                process.wait(timeout=15)
    finally:
        for location in (install, prefilled_path):
            uninstall = location / "Uninstall AJinOS.exe"
            if uninstall.is_file():
                subprocess.run(
                    subprocess.list2cmdline([str(uninstall), "/S"]) + " _?=" + str(location),
                    check=True, timeout=90,
                )

print("PASS: Windows folder selection, preserve/reset data, silent upgrade, bundled MCP, engine stop/start and shutdown", flush=True)
