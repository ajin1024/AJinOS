# Prevent canvas shortcuts from losing their direct navigation in the three-entry shell,
# check independent executor imports, and verify direct navigation + gateway preview/persistence.
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
        errors, writes, discoveries = [], [], []
        page.on("pageerror", lambda error: errors.append(str(error)))

        def protect_workspace(route):
            request = route.request
            if request.url.endswith(("/api/agents/discover", "/api/agents/probe")):
                discoveries.append(request.url)
            if request.method in ("GET", "HEAD"):
                route.continue_()
            elif request.url.endswith("/api/agents/import") and not target_url:
                route.continue_()
            elif request.url.endswith("/api/config") and request.method == "PUT":
                body = request.post_data_json
                writes.append(body)
                if target_url:
                    route.fulfill(json={"value": body["value"], "revision": "ui-test", "profiles": {}, "restartRequired": False})
                else:
                    route.continue_()
            else:
                route.abort()

        page.route("**/api/**", protect_workspace)
        page.goto(url)
        page.wait_for_selector(".super-agent-flow .canvas")

        # Verify the three primary entrances.
        for view in ("messages", "tasks", "settings"):
            expect(page.locator(f'#nav [data-view="{view}"]')).to_have_count(1)
        expect(page.locator("#management-dialog")).to_have_count(0)

        # Canvas shortcuts navigate directly to pages/sections.
        for node, expected_hash, heading in [
            ("github", "#settings/connections", "来源与通知"),
            ("project:ajinos", "#settings/projects/ajinos", None),
            ("workers", "#settings/agents", "执行器"),
            ("hub", "#settings/runtime", "运行环境与引擎"),
            ("timer", "#settings/rules", "规则与定时"),
        ]:
            page.locator('#nav [data-view="tasks"]').click()
            page.get_by_role("button", name="流转概览").click()
            page.wait_for_selector(".super-agent-flow .canvas")
            card = page.locator('.project-card').first if node.startswith('project:') else page.locator(f'[data-node="{node}"]')
            if node.startswith("project:"):
                expected_hash = "#settings/projects/" + card.get_attribute("data-node").split(":", 1)[1]
            (card.get_by_role("button") if node == "workers" else card).click()
            expect(page).to_have_url(re.compile(re.escape(expected_hash) + "$"))
            if heading:
                expect(page.get_by_role("heading", name=heading, exact=True)).to_be_visible()
            else:
                expect(page.locator(".ps-page-host")).to_be_visible()

        # Verify saved executor parameters, node reuse, and copy on a narrow screen.
        page.locator('[data-settings-section="agents"]').click()
        if not target_url:
            for speed, name, model in [
                ("fast", "我的 Sol 执行器", "gpt-6.2-sol"),
                ("", "我的 Astra 执行器", "gpt-6.2-astra"),
            ]:
                page.get_by_role("button", name="新建执行器", exact=True).click()
                dialog = page.get_by_role("dialog", name="新建执行器")
                dialog.get_by_label("软件", exact=True).select_option("codex")
                dialog.get_by_label("模型", exact=True).fill(model)
                dialog.get_by_label("思考强度", exact=True).select_option("high")
                dialog.get_by_label("速度", exact=True).select_option(speed)
                dialog.get_by_label("显示名称").fill(name)
                with page.expect_response(lambda res: res.url.endswith("/api/agents/import")) as response:
                    dialog.get_by_role("button", name="保存", exact=True).click()
                assert response.value.ok, response.value.text()
                expect(dialog).to_have_count(0)
                expect(page.get_by_role("row").filter(has_text=name)).to_contain_text(model)
                if speed:
                    sol_id = response.value.json()["agentId"]
            page.reload()
            expect(page.get_by_text("我的 Sol 执行器", exact=True)).to_be_visible()
            expect(page.get_by_text("我的 Astra 执行器", exact=True)).to_be_visible()
            page.goto(url + "/#settings/projects/orders")
            page.get_by_role("button", name="项目流程", exact=True).click()
            flow = page.get_by_role("dialog", name=re.compile("项目流程"))
            flow.get_by_label("需求确认的执行器").select_option(sol_id)
            flow.get_by_role("button", name=re.compile("执行任务")).click()
            flow.get_by_label("执行任务的执行器").select_option(sol_id)
            expect(flow.get_by_text("快速", exact=True)).to_be_visible()
            with page.expect_response(lambda res: res.url.endswith("/api/config") and res.request.method == "PUT") as response:
                flow.get_by_role("button", name="保存流程", exact=True).click()
            assert response.value.ok, response.value.text()
            expect(flow).to_have_count(0)
            page.goto(url + "/#settings/agents")
            page.get_by_role("button", name="编辑我的 Sol 执行器").click()
            edit = page.get_by_role("dialog", name="编辑执行器")
            expect(edit.locator(".sc-executor-references li")).to_have_text([
                "订单服务 · 演示 / 默认流程 / 需求确认", "订单服务 · 演示 / 默认流程 / 执行任务",
            ])
            edit.get_by_role("button", name="取消", exact=True).click()
            page.set_viewport_size({"width": 390, "height": 800})
            page.get_by_role("button", name="复制我的 Sol 执行器").click()
            dialog = page.get_by_role("dialog", name="复制执行器")
            expect(dialog.get_by_label("模型", exact=True)).to_have_value("gpt-6.2-sol")
            expect(dialog.get_by_label("思考强度")).to_have_value("high")
            assert dialog.evaluate("el => el.getBoundingClientRect().width <= window.innerWidth")
            dialog.get_by_role("button", name="取消", exact=True).click()
            page.set_viewport_size({"width": 1600, "height": 1000})
        assert not discoveries, discoveries

        # Verify gateway preview & save.
        page.locator('#nav [data-view="settings"]').click()
        page.locator('[data-settings-section="gateway"]').click()
        page.locator('textarea[name="blockedTerms"]').fill("删除生产数据\nDROP TABLE")
        page.locator('textarea[name="probe"]').fill("please drop table orders")
        expect(page.locator("#gateway-probe-result")).to_contain_text("会拦截")
        page.get_by_role("button", name="保存网关规则", exact=True).click()
        assert writes[-1]["value"]["gateway"]["blockedTerms"] == ["删除生产数据", "DROP TABLE"]

        # Verify responsive layout across all settings sections and projects.
        for width in (1280, 640, 390):
            page.set_viewport_size({"width": width, "height": 800})
            for section in ("rules", "connections", "runtime", "agents", "gateway", "advanced"):
                if width < 960:
                    page.get_by_role("button", name="能力与沙箱导航", exact=True).click()
                page.locator(f'[data-settings-section="{section}"]').click()
                expect(page.get_by_role("region", name="能力与沙箱内容")).to_be_visible()
                assert page.locator("#main").evaluate("el => el.scrollWidth <= el.clientWidth + 1")
            page.locator('#nav [data-view="settings"]').click()
            expect(page.locator(".ps-page-host")).to_be_visible()
            assert page.locator("#main").evaluate("el => el.scrollWidth <= el.clientWidth + 1")
            page.locator('#nav [data-view="settings"]').click()

        assert not errors, errors
        browser.close()
        print("Direct canvas navigation, executor settings, gateway preview and responsive checks passed.")

if target_url:
    run_test(target_url)
else:
    with tempfile.TemporaryDirectory(prefix="studio-mgmt-ui-") as home:
        script = """
          import { startDemoStudio as startStudio } from './client/tests/studio-fixtures.mjs';
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
