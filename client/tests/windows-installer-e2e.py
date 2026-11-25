# Catch an installer that succeeds but cannot open Studio or run its Hub and Worker without a system Node.js.
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

root = Path(__file__).resolve().parents[1]
installer = (Path(sys.argv[1]) if len(sys.argv) > 1 else root / "dist/AJinOS-Setup-x64.exe").resolve()


def free_port():
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


def wait_for(read, timeout=40):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        result = read()
        if result:
            return result
        time.sleep(0.2)
    raise AssertionError("Timed out waiting for the installed application")


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
    install = temp / "Studio 安装"
    home = temp / "data"
    launch = install / "AJinOS.exe"
    uninstall = install / "Uninstall AJinOS.exe"
    subprocess.run(
        subprocess.list2cmdline([str(installer), "/S"]) + " /D=" + str(install),
        check=True, timeout=120,
    )
    try:
        assert launch.is_file(), launch
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
                    expect(page.locator(".fc-canvas")).to_be_attached()
                    expect(page.locator("html")).to_be_visible()
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
                    page.locator("#engine-power").click()
                    initial = wait_for(lambda: (snapshot := state())["connected"] and snapshot)
                    engine = page.request.get(origin + "/api/engine").json()
                    assert initial["enginePid"] == engine["pid"]
                    page.locator("#open-versions").click()
                    expect(page.locator("#versions-body")).to_contain_text("Windows 安装版")
                    page.locator("#versions-close").click()

                    page.locator('[data-view="settings"]').click()
                    page.locator('[data-action="engine-stop"]').click()
                    page.get_by_role("dialog").get_by_role("button", name="停止引擎", exact=True).click()
                    expect(page.locator('[data-action="engine-start"]')).to_be_visible()
                    stopped = state()
                    assert stopped["engineStopped"] and not stopped["connected"] and stopped["enginePid"] is None
                    page.locator('[data-action="engine-start"]').click()
                    expect(page.locator('[data-action="engine-stop"]')).to_be_visible(timeout=20000)
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
            print("PASS: Windows x64 installer, AJinOS default project, bundled MCP, engine stop/start and shutdown", flush=True)
        finally:
            if process.poll() is None:
                subprocess.run(["taskkill.exe", "/PID", str(process.pid), "/T", "/F"], capture_output=True)
                process.wait(timeout=15)
    finally:
        if uninstall.is_file():
            subprocess.run(
                subprocess.list2cmdline([str(uninstall), "/S"]) + " _?=" + str(install),
                check=True, timeout=90,
            )
