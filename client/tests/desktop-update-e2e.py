# Prevent a nominal version switch that never replaces the real Electron process/backend, or loses workspace data.
# Uses two tagged copies of the actual application, real npm installation, real Electron, and an isolated home/profile.
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import tempfile
import time
import urllib.request
from playwright.sync_api import sync_playwright, expect

root = Path(__file__).resolve().parents[2]
flags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0

def run(args, cwd):
    return subprocess.check_output(args, cwd=cwd, text=True, encoding="utf-8", stderr=subprocess.STDOUT, creationflags=flags).strip()

def free_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]

def wait_for(check, seconds=180):
    until = time.monotonic() + seconds
    last = None
    while time.monotonic() < until:
        try:
            result = check()
            if result: return result
        except AssertionError: raise
        except Exception as e: last = e
        time.sleep(.3)
    raise AssertionError(f"Timed out: {last}")

def desktop_page(browser, port):
    context = browser.contexts[0]
    page = context.pages[0] if context.pages else context.wait_for_event("page", timeout=45000)
    page.wait_for_url(f"http://127.0.0.1:{port}/", timeout=45000)
    return page

with tempfile.TemporaryDirectory(prefix="studio-desktop-e2e-") as temp:
    temp = Path(temp)
    repo, home, store = temp / "source", temp / "home", temp / "versions"
    repo.mkdir(); home.mkdir()
    files = run(["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"], root).split("\0")
    for name in set(files):
        if not name or not (root / name).is_file(): continue
        destination = repo / name
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(root / name, destination)
    git = lambda *args: run(["git", *args], repo)
    git("init"); git("config", "user.name", "Desktop acceptance"); git("config", "user.email", "test@example.invalid")
    git("add", "."); git("commit", "-m", "初始桌面版本"); git("tag", "-a", "v90.0.0", "-m", "验收初版：清透薄荷日夜模式")
    (repo / "client/release-proof.txt").write_text("真实更新后的程序文件", encoding="utf-8")
    git("add", "."); git("commit", "-m", "新增版本更新验收标记"); git("tag", "-a", "v90.1.0", "-m", "验收新版：完整桌面更新与回滚")
    git("checkout", "--detach", "v90.0.0"); git("remote", "add", "origin", str(repo))
    (repo / "local-work.txt").write_text("保留未提交工作", encoding="utf-8")
    shutil.copytree(root / "client/node_modules", repo / "client/node_modules")
    port, debug = free_port(), free_port()
    env = {**os.environ, "STUDIO_HOME": str(home), "STUDIO_PORT": str(port), "STUDIO_VERSION_STORE": str(store),
           "STUDIO_DESKTOP_PROFILE": str(temp / "profile"), "STUDIO_WINDOW_HIDDEN": "1", "STUDIO_AUTOSTART": "1"}
    env.pop("ELECTRON_RUN_AS_NODE", None)
    log = (temp / "desktop.log").open("w", encoding="utf-8")
    process = subprocess.Popen(["node", str(repo / "client/desktop-launch.mjs"), f"--remote-debugging-port={debug}"], cwd=repo, env=env,
        stdin=subprocess.PIPE, stdout=log, stderr=log, creationflags=flags)
    browser = None
    try:
        with sync_playwright() as p:
            print("Connecting to real Electron", debug, flush=True)
            def connect():
                urllib.request.urlopen(f"http://127.0.0.1:{debug}/json/version", timeout=1).close()
                return p.chromium.connect_over_cdp(f"http://127.0.0.1:{debug}")
            browser = wait_for(connect)
            print("Connected", flush=True)
            page = desktop_page(browser, port)
            page.wait_for_selector(".mc-stage, .super-agent-flow .canvas")
            print("Canvas ready", flush=True)
            for _ in range(3):
                if page.locator("html").get_attribute("data-theme-mode") == "dark":
                    break
                page.locator("#rail-theme").click()
            config = page.request.get(f"http://127.0.0.1:{port}/api/config").json()
            config["value"]["projects"][0]["aliases"].append("更新后必须保留")
            assert page.request.put(f"http://127.0.0.1:{port}/api/config", headers={"x-studio-action":"1"}, data={"value":config["value"], "revision":config["revision"]}).ok
            page.locator("#open-versions").click()
            expect(page.locator(".version-current")).to_contain_text("v90.0.0")
            print("Checking tags", flush=True)
            page.get_by_role("button", name="检查更新", exact=True).click()
            expect(page.locator(".version-release")).to_contain_text("验收新版", timeout=30000)
            page.get_by_role("button", name="更新并重启", exact=True).click()
            page.get_by_role("button", name="确认切换", exact=True).click()
            print("Installing update", flush=True)
            state_file = store / "state.json"
            def switched(tag):
                state = json.loads(state_file.read_text(encoding="utf-8"))
                assert "自动恢复" not in state["notice"], state["notice"]
                active = next(v for v in state["history"] if v["id"] == state["active"])
                return active if active["tag"] == tag and not state["pending"] else None
            updated = wait_for(lambda: switched("v90.1.0"), 240)
            assert (Path(updated["root"]) / "client/release-proof.txt").read_text(encoding="utf-8") == "真实更新后的程序文件"
            browser = wait_for(connect)
            page = desktop_page(browser, port)
            page.wait_for_selector(".mc-stage, .super-agent-flow .canvas")
            expect(page.locator("html")).to_have_attribute("data-theme", "dark")
            actual = page.request.get(f"http://127.0.0.1:{port}/api/version").json()
            assert actual["current"]["tag"] == "v90.1.0", actual
            after = page.request.get(f"http://127.0.0.1:{port}/api/config").json()
            assert "更新后必须保留" in after["value"]["projects"][0]["aliases"]
            page.locator("#open-versions").click()
            page.get_by_role("button", name="回滚到此版本", exact=True).click()
            page.get_by_role("button", name="确认切换", exact=True).click()
            wait_for(lambda: switched("v90.0.0"), 60)
            browser = wait_for(connect)
            page = desktop_page(browser, port)
            page.wait_for_selector(".mc-stage, .super-agent-flow .canvas")
            assert page.request.get(f"http://127.0.0.1:{port}/api/version").json()["current"]["tag"] == "v90.0.0"
            assert "更新后必须保留" in page.request.get(f"http://127.0.0.1:{port}/api/config").json()["value"]["projects"][0]["aliases"]
            assert (repo / "local-work.txt").read_text(encoding="utf-8") == "保留未提交工作"
            print("Update and rollback passed; checking failed renderer recovery", flush=True)
            git("checkout", "--detach", "v90.1.0")
            source = repo / "client/src/app.js"
            source.write_text("throw new Error('intentional frontend startup failure');\n" + source.read_text(encoding="utf-8"), encoding="utf-8")
            git("add", "client/src/app.js"); git("commit", "-m", "启动失败验收版本"); git("tag", "v90.2.0")
            git("checkout", "--detach", "v90.0.0")
            page.locator("#open-versions").click()
            page.get_by_role("button", name="检查更新", exact=True).click()
            expect(page.locator(".version-release")).to_contain_text("v90.2.0", timeout=30000)
            page.get_by_role("button", name="更新并重启", exact=True).click()
            page.get_by_role("button", name="确认切换", exact=True).click()
            wait_for(lambda: "自动恢复" in json.loads(state_file.read_text(encoding="utf-8"))["notice"], 240)
            browser = wait_for(connect)
            page = desktop_page(browser, port)
            page.wait_for_selector(".mc-stage, .super-agent-flow .canvas")
            assert page.request.get(f"http://127.0.0.1:{port}/api/version").json()["current"]["tag"] == "v90.0.0"
            assert page.request.get(f"http://127.0.0.1:{port}/api/state").json()["connected"] is True
            process.stdin.write(b"shutdown\n"); process.stdin.flush()
            process.wait(timeout=20)
            print("PASS: real Electron v90.0.0 -> install v90.1.0 -> restart shell/backend -> rollback v90.0.0 -> failed v90.2.0 renderer -> auto recovery; project data, theme and dirty checkout retained")
    except Exception:
        log.flush()
        print((temp / "desktop.log").read_text(encoding="utf-8", errors="replace")[-6000:])
        if (store / "state.json").exists(): print((store / "state.json").read_text(encoding="utf-8"))
        raise
    finally:
        if process.poll() is None:
            if os.name == "nt": subprocess.run(["taskkill", "/PID", str(process.pid), "/T", "/F"], capture_output=True)
            else: process.terminate()
            process.wait(timeout=20)
        log.close()
