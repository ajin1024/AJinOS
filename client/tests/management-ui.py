# Prevent canvas shortcuts from opening nested dialogs, keep the 4-item top navigation,
# enforce read-only executors, and verify direct navigation + gateway preview/persistence.
import json
import os
from pathlib import Path
from queue import Queue
import re
import subprocess
import sys
import tempfile
from threading import Thread
from playwright.sync_api import sync_playwright, expect

root = Path(__file__).resolve().parents[2]
target_url = sys.argv[1] if len(sys.argv) > 1 else None

def run_test(url):
    with sync_playwright() as p:
        browser = p.chromium.launch(channel="msedge", headless=True)
        page = browser.new_page(viewport={"width": 1600, "height": 1000})
        page.set_default_timeout(10000)
        errors, writes = [], []
        page.on("pageerror", lambda error: errors.append(str(error)))

        def protect_workspace(route):
            request = route.request
            if request.method in ("GET", "HEAD"):
                route.continue_()
            elif request.url.endswith("/api/config") and request.method == "PUT":
                body = request.post_data_json
                writes.append(body)
                route.fulfill(json={"value": body["value"], "revision": "ui-test", "profiles": {}, "restartRequired": False})
            else:
                route.abort()

        page.route("**/api/**", protect_workspace)
        page.goto(url)
        page.wait_for_selector(".fc-canvas")

        # Verify 4 clean primary nav items and zero management dialog.
        for view in ("overview", "tasks", "projects", "settings"):
            expect(page.locator(f'#nav [data-view="{view}"]')).to_have_count(1)
        expect(page.locator("#management-dialog")).to_have_count(0)

        # Canvas shortcuts navigate directly to pages/sections.
        for name, expected_hash, heading in [
            ("消息接收管理", "#settings/connections", "来源与通知"),
            ("项目管理", "#projects", None),
            ("模型执行器查看", "#settings/agents", "执行器与模型"),
            ("项目网关管理", "#settings/gateway", "项目识别网关"),
            ("规则与定时", "#settings/rules", "规则与定时"),
        ]:
            page.locator('#nav [data-view="overview"]').click()
            page.wait_for_selector(".fc-canvas")
            page.get_by_role("button", name=name, exact=True).click()
            expect(page).to_have_url(re.compile(re.escape(expected_hash) + "$"))
            if heading:
                expect(page.get_by_role("heading", name=heading, exact=True)).to_be_visible()
            else:
                expect(page.get_by_role("button", name="添加项目", exact=True)).to_be_visible()

        # Verify agents view is strictly read-only.
        page.locator('[data-settings-section="agents"]').click()
        expect(page.locator('[data-action="agent"], [data-action="agent-new"], [data-action="model-preset"], [data-action="agent-delete"]')).to_have_count(0)

        # Verify gateway preview & save.
        page.locator('[data-settings-section="gateway"]').click()
        page.locator('textarea[name="blockedTerms"]').fill("删除生产数据\nDROP TABLE")
        page.locator('textarea[name="probe"]').fill("please drop table orders")
        expect(page.locator("#gateway-probe-result")).to_contain_text("会拦截")
        page.get_by_role("button", name="保存网关规则", exact=True).click()
        assert writes[-1]["value"]["gateway"]["blockedTerms"] == ["删除生产数据", "DROP TABLE"]

        # Verify responsive layout across all settings sections and projects.
        for width in (1280, 640, 390):
            page.set_viewport_size({"width": width, "height": 800})
            for section in ("gateway", "rules", "connections", "runtime", "agents", "advanced"):
                page.locator(f'[data-settings-section="{section}"]').click()
                assert page.locator("#main").evaluate("el => el.scrollWidth <= el.clientWidth + 1")
            page.locator('#nav [data-view="projects"]').click()
            expect(page.locator(".ps-page-host")).to_be_visible()
            assert page.locator("#main").evaluate("el => el.scrollWidth <= el.clientWidth + 1")
            page.locator('#nav [data-view="settings"]').click()

        assert not errors, errors
        browser.close()
        print("Direct canvas navigation, 4-tab header, read-only executors, gateway preview and responsive checks passed.")

if target_url:
    run_test(target_url)
else:
    with tempfile.TemporaryDirectory(prefix="studio-mgmt-ui-") as home:
        script = """
          import { startStudio } from './client/server.mjs';
          const studio = await startStudio({home: process.argv[1], port: 0, autostart: true});
          console.log(JSON.stringify({url: studio.url}));
          process.stdin.once('data', async () => { await studio.close(); process.exit(0); });
        """
        process = subprocess.Popen(["node", "--input-type=module", "-e", script, home], cwd=root,
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, encoding="utf-8",
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
        ready = Queue()
        Thread(target=lambda: ready.put(process.stdout.readline()), daemon=True).start()
        try:
            url = json.loads(ready.get(timeout=45))["url"]
            run_test(url)
        finally:
            if process.poll() is None:
                process.stdin.write("stop\n"); process.stdin.flush()
                process.wait(timeout=20)
