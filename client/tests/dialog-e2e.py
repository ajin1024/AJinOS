# Prevent functional-looking forms from losing project bindings or saving gateway rules that never intercept messages.
# This test starts an isolated Studio and its real Hub; model classification is replaced, not configuration persistence.
import json
import os
from pathlib import Path
from queue import Queue
import subprocess
import tempfile
from threading import Thread
from playwright.sync_api import sync_playwright, expect


root = Path(__file__).resolve().parents[2]
with tempfile.TemporaryDirectory(prefix="studio-dialog-e2e-") as temp:
    home = Path(temp)
    workspace = home / "project"
    moved = home / "moved"
    workspace.mkdir()
    moved.mkdir()
    (workspace / "README.md").write_text("测试项目", encoding="utf-8")
    (moved / "README.md").write_text("迁移测试项目", encoding="utf-8")
    script = """
      import { startDemoStudio as startStudio } from './client/tests/studio-fixtures.mjs';
      const studio = await startStudio({ home: process.argv[1], port: 0, autostart: true,
        gatewayModel: async () => ({ summary: '隔离测试画像', tags: ['测试'], tasks: ['校验'] }) });
      console.log(JSON.stringify({ url: studio.url }));
      process.stdin.once('data', async () => { await studio.close(); process.exit(0); });
    """
    with (home / "stderr.log").open("w", encoding="utf-8") as stderr:
        process = subprocess.Popen(
            ["node", "--input-type=module", "-e", script, str(home)], cwd=root,
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=stderr, text=True, encoding="utf-8",
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
        )
        ready = Queue()
        Thread(target=lambda: ready.put(process.stdout.readline()), daemon=True).start()
        try:
            url = json.loads(ready.get(timeout=45))["url"]
            with sync_playwright() as p:
                browser = p.chromium.launch(channel="msedge", headless=True)
                try:
                    page = browser.new_page(viewport={"width": 1440, "height": 960})
                    page.set_default_timeout(15000)
                    page.goto(url)
                    page.wait_for_selector(".fc-canvas")

                    # Create project on first-level Project Space page
                    page.get_by_role("button", name="项目管理", exact=True).click()
                    page.get_by_role("button", name="添加项目", exact=True).click()
                    page.locator('input[name="name"]').fill("弹窗验收项目")
                    page.locator('input[name="cwd"]').fill(str(workspace))
                    page.get_by_text("高级配置", exact=False).click()
                    page.locator('input[name="id"]').fill("ui-review")
                    page.locator('input[name="rule"]').fill("ui-review-task")
                    page.get_by_role("button", name="保存项目", exact=True).click()
                    expect(page.locator(".ps-editor")).not_to_be_visible()
                    page.get_by_role("button", name="查看弹窗验收项目", exact=True).click()
                    expect(page.get_by_role("heading", name="弹窗验收项目", exact=True)).to_be_visible()

                    # Add flow via SideSheet
                    page.get_by_role("button", name="添加流程", exact=True).click()
                    sheet = page.locator(".semi-sidesheet")
                    sheet.locator('input[name="id"]').fill("audit")
                    sheet.locator('input[name="name"]').fill("核查")
                    sheet.locator('textarea[name="description"]').fill("检查记录")
                    sheet.locator('textarea[name="prompt"]').fill("检查资料并交回结果")
                    sheet.get_by_role("button", name="保存流程", exact=True).click()
                    expect(sheet).not_to_be_visible()
                    project_details = page.get_by_role("dialog", name="弹窗验收项目", exact=True)
                    expect(project_details.get_by_text("默认流程、核查", exact=True)).to_be_visible()
                    page.keyboard.press("Escape")
                    expect(project_details).not_to_be_visible()

                    # Rename flow rule in Settings -> Rules
                    page.locator('#nav [data-view="settings"]').click()
                    page.locator('[data-settings-section="rules"]').click()
                    page.locator('[data-rule-id="弹窗验收项目 · 核查"]').click()
                    sheet = page.locator(".semi-sidesheet")
                    expect(sheet.locator('input[name="cwd"]')).to_be_disabled()
                    sheet.locator('input[name="name"]').fill("renamed-audit")
                    sheet.get_by_role("button", name="保存规则", exact=True).click()
                    expect(sheet).not_to_be_visible()

                    # Move project directory & rule name to verify flow rule isolation
                    page.locator('#nav [data-view="projects"]').click()
                    page.get_by_role("button", name="查看弹窗验收项目", exact=True).click()
                    page.get_by_role("button", name="编辑项目", exact=True).click()
                    page.locator('input[name="cwd"]').fill(str(moved))
                    page.get_by_text("高级配置", exact=False).click()
                    page.locator('input[name="rule"]').fill("ui-review-moved")
                    page.get_by_role("button", name="保存项目", exact=True).click()
                    expect(page.locator(".ps-editor")).not_to_be_visible()

                    saved = page.request.get(url + "/api/config").json()["value"]
                    project = next(item for item in saved["projects"] if item["id"] == "ui-review")
                    flow_name = project["flows"][0]["rule"]
                    assert flow_name != "renamed-audit"
                    assert next(rule for rule in saved["rules"]["rules"] if rule["name"] == flow_name)["cwd"] == str(moved)
                    assert not any(rule["name"] == "renamed-audit" for rule in saved["rules"]["rules"])

                    # Gateway blockedTerms persistence & real 422 interception
                    page.locator('#nav [data-view="settings"]').click()
                    page.locator('[data-settings-section="gateway"]').click()
                    page.locator('textarea[name="blockedTerms"]').fill("禁止测试词")
                    page.get_by_role("button", name="保存网关规则", exact=True).click()
                    page.reload()
                    expect(page.locator('textarea[name="blockedTerms"]')).to_have_value("禁止测试词")

                    form = page.locator("#new-task-form")
                    page.locator("#new-task").click()
                    form.locator('[name="project"]').select_option("ui-review")
                    form.locator('[name="text"]').fill("禁止测试词")
                    page.locator("#dialog-submit").click()
                    expect(page.locator("#dialog-error")).to_contain_text("已拦截")
                    expect(form).to_be_visible()
                    assert page.request.get(url + "/api/messages").json() == []
                    print("Real browser + HTTP: project creation, flow rename, directory isolation, persistent gateway rules and blocked submission passed.")
                finally:
                    browser.close()
        finally:
            if process.poll() is None:
                try:
                    process.stdin.write("shutdown\n")
                    process.stdin.flush()
                    process.wait(timeout=30)
                except (subprocess.TimeoutExpired, BrokenPipeError):
                    if os.name == "nt":
                        subprocess.run(["taskkill", "/PID", str(process.pid), "/T", "/F"], check=False, capture_output=True)
                    else:
                        process.kill()
                    process.wait(timeout=10)
