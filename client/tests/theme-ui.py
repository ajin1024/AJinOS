# Prevent mixed light/dark surfaces, lost theme preferences, and a refresh button that only redraws cached state.
# Prevent page-specific styles from replacing the shared mint accent with another palette.
# A real isolated Studio serves these pages. SSE keeps the network open; wait for the rendered canvas instead of networkidle.
import json
import os
from pathlib import Path
from queue import Queue
import subprocess
import sys
import tempfile
from threading import Thread
from playwright.sync_api import sync_playwright, expect

root = Path(__file__).resolve().parents[2]
artifacts = Path(sys.argv[1]) if len(sys.argv) > 1 else None
if artifacts:
    artifacts.mkdir(parents=True, exist_ok=True)
with tempfile.TemporaryDirectory(prefix="studio-theme-ui-") as temp:
    script = """
      import { startDemoStudio as startStudio } from './client/tests/studio-fixtures.mjs';
      const s = await startStudio({home: process.argv[1], port: 0, autostart: true, businessTasks: true});
      console.log(JSON.stringify({url:s.url}));
      process.stdin.once('data',async()=>{await s.close();process.exit(0)});
    """
    process = subprocess.Popen(["node", "--input-type=module", "-e", script, temp], cwd=root,
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, encoding="utf-8",
        creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
    ready = Queue()
    Thread(target=lambda: ready.put(process.stdout.readline()), daemon=True).start()
    try:
        url = json.loads(ready.get(timeout=45))["url"]
        with sync_playwright() as p:
            browser = p.chromium.launch(channel="msedge", headless=True)
            page = browser.new_page(viewport={"width": 1600, "height": 1000})
            errors = []
            page.on("pageerror", lambda e: errors.append(str(e)))
            page.goto(url)
            page.wait_for_selector(".fc-canvas")
            page.wait_for_function("async () => (await (await fetch('/api/state')).json()).connected")
            submitted = page.request.post(url + "/api/messages", headers={"x-studio-action": "1"},
                data={"id": "theme-task", "project": "orders", "text": "核对演示结果并直接完成", "requirementsConfirmed": True})
            assert submitted.ok, submitted.text()
            assert not submitted.json().get("needsProject"), submitted.text()
            page.wait_for_function("""async () => {
                const {state} = await (await fetch('/api/state')).json();
                return state?.runs.some(run => run.state === 'done');
            }""")
            for theme in ["light", "dark"]:
                page.locator("#status-capsule").click()
                page.locator(f'[data-theme-choice="{theme}"]').click()
                page.locator("#status-capsule").click()
                expect(page.locator("html")).to_have_attribute("data-theme", theme)
                if theme == "dark":
                    expect(page.locator("body")).to_have_attribute("theme-mode", "dark")
                accent_ink = "rgb(165, 231, 197)" if theme == "dark" else "rgb(54, 120, 91)"
                assert page.locator("#nav .nav-item.active").evaluate("e=>getComputedStyle(e).color") == accent_ink
                assert page.locator("#new-task").evaluate("e=>getComputedStyle(e).backgroundColor") == "rgb(165, 231, 197)"
                if artifacts: page.screenshot(path=str(artifacts / f"mint-{theme}-workbench.png"), full_page=True)
                expected = "rgb(29, 32, 38)" if theme == "dark" else "rgb(255, 255, 255)"

                # Canvas shortcuts navigate directly to pages without nested management dialogs.
                page.get_by_role("button", name="项目网关管理", exact=True).click()
                expect(page.get_by_role("heading", name="项目识别网关", exact=True)).to_be_visible()
                if artifacts: page.screenshot(path=str(artifacts / f"mint-{theme}-gateway.png"), full_page=True)

                page.locator('#nav [data-view="projects"]').click()
                expect(page.get_by_role("region", name="项目卡片")).to_be_visible()
                page.get_by_role("button", name="添加项目", exact=True).click()
                field = page.locator('input[name="name"]')
                field.fill("尚未保存的输入")
                page.locator("#status-capsule").click()
                page.locator("#refresh-app").click()
                expect(field).to_have_value("尚未保存的输入")
                page.keyboard.press("Escape")
                expect(page.locator(".ps-editor")).not_to_be_visible()
                if artifacts: page.screenshot(path=str(artifacts / f"mint-{theme}-projects.png"), full_page=True)

                page.locator("#status-capsule").click()
                page.locator("#open-versions").click()
                expect(page.locator(".version-current")).to_be_visible()
                expect(page.locator("#versions-body")).to_contain_text("浏览器中查看")
                if artifacts: page.screenshot(path=str(artifacts / f"mint-{theme}-versions.png"), full_page=True)
                page.keyboard.press("Escape")

                page.locator('#nav [data-view="overview"]').click()
                page.wait_for_selector(".fc-canvas")
                page.evaluate("window.refreshProof = 1")
                page.locator("#status-capsule").click()
                page.locator("#refresh-app").click()
                page.wait_for_selector(".fc-canvas")
                assert page.evaluate("window.refreshProof") is None
                expect(page.locator("html")).to_have_attribute("data-theme", theme)

                page.locator('#nav [data-view="tasks"]').click()
                expect(page.get_by_role("region", name="任务看板")).to_be_visible()
                if artifacts: page.screenshot(path=str(artifacts / f"mint-{theme}-kanban.png"), full_page=True)
                page.locator(".kb-card").first.click()
                expect(page.locator("#task-tabs")).to_be_visible()
                assert page.locator("#drawer").evaluate("e=>getComputedStyle(e).backgroundColor") == expected
                if artifacts: page.screenshot(path=str(artifacts / f"mint-{theme}-task-detail.png"), full_page=True)
                page.keyboard.press("Escape")

                page.locator('#nav [data-view="settings"]').click()
                expect(page.locator(".admin-settings")).to_be_visible()
                if artifacts: page.screenshot(path=str(artifacts / f"mint-{theme}-settings.png"), full_page=True)
                page.locator('#nav [data-view="overview"]').click()

            page.locator("#status-capsule").click()
            page.locator('[data-theme-choice="system"]').click()
            page.locator("#status-capsule").click()
            for theme in ["dark", "light"]:
                page.emulate_media(color_scheme=theme)
                expect(page.locator("html")).to_have_attribute("data-theme", theme)
            assert not errors, errors
            browser.close()
        print("PASS: both themes, all surfaces, unsaved guard, system theme and real reload")
    finally:
        if process.poll() is None:
            process.stdin.write("stop\n"); process.stdin.flush()
            try: process.wait(timeout=20)
            except subprocess.TimeoutExpired:
                if os.name == "nt": subprocess.run(["taskkill", "/PID", str(process.pid), "/T", "/F"], capture_output=True)
                else: process.kill()
                process.wait()
