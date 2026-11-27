# Prevent mixed light/dark surfaces, lost theme preferences, or regressions in sidebar logo, theme cycle, and version footer.
# Prevent the global accent from replacing the independent online status color.
# A real isolated Studio serves these pages. SSE keeps the network open; wait for the rendered canvas instead of networkidle.
import json
import os
from pathlib import Path
from queue import Queue
import subprocess
import sys
from studio_home import studio_home
from threading import Thread
from playwright.sync_api import sync_playwright, expect

root = Path(__file__).resolve().parents[2]
artifacts = Path(sys.argv[1]) if len(sys.argv) > 1 else None
if artifacts:
    artifacts.mkdir(parents=True, exist_ok=True)
with studio_home("studio-theme-ui-") as temp:
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
            page.goto(url + "/#overview")
            page.wait_for_selector(".super-agent-flow .canvas")
            page.wait_for_function("async () => (await (await fetch('/api/state')).json()).connected")
            page.goto(url + "/#settings/runtime")
            expect(page.get_by_text("外观主题", exact=True)).to_be_visible()
            page.get_by_role("radio", name="瓷白蓝紫", exact=True).click()
            expect(page.locator("#engine-power")).to_have_css("color", "rgb(22, 138, 91)")
            page.goto(url + "/#overview")
            submitted = page.request.post(url + "/api/messages", headers={"x-studio-action": "1"},
                data={"id": "theme-task", "project": "orders", "text": "核对演示结果并直接完成", "requirementsConfirmed": True})
            assert submitted.ok, submitted.text()
            assert not submitted.json().get("needsProject"), submitted.text()
            for index, (project, title) in enumerate([
                ("orders", "检查支付回调"), ("orders", "整理退款记录"), ("orders", "核对订单库存"),
                ("orders", "整理发货清单"), ("content", "更新素材目录并直接完成"),
            ]):
                submitted = page.request.post(url + "/api/messages", headers={"x-studio-action": "1"},
                    data={"id": f"theme-thread-{index}", "project": project, "text": title, "requirementsConfirmed": True})
                assert submitted.ok and submitted.json().get("project") == project, submitted.text()
            page.wait_for_function("""async () => {
                const {state} = await (await fetch('/api/state')).json();
                return state?.runs.some(run => run.state === 'done');
            }""")
            for theme in ["light", "dark"]:
                page.goto(url + "/#settings/runtime")
                page.get_by_role("radio", name={"light": "瓷白蓝紫", "dark": "深蓝灰"}[theme]).click()
                page.goto(url + "/#overview")
                expect(page.locator("html")).to_have_attribute("data-theme", theme)
                if theme == "dark":
                    expect(page.locator("body")).to_have_attribute("theme-mode", "dark")
                accent = "#7aa2f7" if theme == "dark" else "#4f6ae8"
                assert page.locator("html").evaluate("e=>getComputedStyle(e).getPropertyValue('--ui-accent').trim().toLowerCase()") == accent
                if artifacts: page.screenshot(path=str(artifacts / f"{theme}-workbench.png"), full_page=True)
                expected = "rgb(33, 38, 54)" if theme == "dark" else "rgb(255, 255, 255)"

                page.get_by_role("button", name="和 AJinOS 总管沟通").click()
                chat = page.get_by_role("dialog", name="AJinOS 总管沟通")
                expect(chat).to_have_css("background-color", expected)
                if artifacts: page.screenshot(path=str(artifacts / f"{theme}-floating-chat.png"))
                page.keyboard.press("Escape")
                expect(chat).to_have_count(0)
                page.goto(url + "/#settings/gateway")
                expect(page.get_by_role("heading", name="项目识别网关", exact=True)).to_be_visible()
                if artifacts: page.screenshot(path=str(artifacts / f"{theme}-gateway.png"), full_page=True)

                page.locator('#nav [data-view="settings"]').click()
                expect(page.get_by_role("region", name="项目卡片")).to_be_visible()
                if artifacts: page.screenshot(path=str(artifacts / f"{theme}-projects.png"), full_page=True)

                expect(page.locator("#refresh-app")).to_have_count(0)
                logo = page.locator(".studio-brand img.studio-brand-logo")
                expect(logo).to_be_visible()
                expect(logo).to_have_attribute("src", "/icon.png")
                assert logo.evaluate("img => img.complete && img.naturalWidth > 0")

                version_btn = page.locator("#open-versions")
                expect(version_btn).to_be_visible()
                expect(version_btn.locator(".semi-icon")).to_have_count(0)
                assert version_btn.inner_text().strip() != ""
                version_btn.click()
                expect(page.locator(".version-current")).to_be_visible()
                expect(page.locator("#versions-body")).to_contain_text("浏览器中查看")
                if artifacts: page.screenshot(path=str(artifacts / f"{theme}-versions.png"), full_page=True)
                page.keyboard.press("Escape")

                page.goto(url + "/#overview")
                page.wait_for_selector(".super-agent-flow .canvas")
                page.reload()
                page.wait_for_selector(".super-agent-flow .canvas")
                expect(page.locator("html")).to_have_attribute("data-theme", theme)

                page.get_by_role("button", name="工单看板", exact=True).click()
                expect(page.get_by_role("region", name="任务看板")).to_be_visible()
                header = page.locator(".kb-col-head").first.bounding_box()
                controls = page.locator(".tc-tools").bounding_box()
                assert controls["y"] + controls["height"] <= header["y"] + 1
                if artifacts: page.screenshot(path=str(artifacts / f"{theme}-kanban.png"), full_page=True)
                page.locator(".kb-card").first.click()
                expect(page.locator("#task-tabs")).to_be_visible()
                assert page.locator("#drawer").evaluate("e=>getComputedStyle(e).backgroundColor") == expected
                assert abs(page.locator("#drawer").bounding_box()["width"] - 368) <= 1
                if artifacts: page.screenshot(path=str(artifacts / f"{theme}-task-detail.png"), full_page=True)
                page.keyboard.press("Escape")

                page.locator('#nav [data-view="settings"]').click()
                expect(page.locator(".admin-settings")).to_be_visible()
                if artifacts: page.screenshot(path=str(artifacts / f"{theme}-settings.png"), full_page=True)
                page.locator('#nav [data-view="messages"]').click()
                sidebar = page.get_by_role("complementary", name="对话列表")
                expect(sidebar).to_be_visible()
                assert abs(sidebar.bounding_box()["width"] - 268) <= 1
                sidebar.get_by_role("combobox", name="按项目筛选事项").select_option("orders")
                expect(sidebar.locator(".thread-item")).to_have_count(5)
                expect(page.locator(".composer textarea")).to_be_in_viewport()
                if artifacts: page.screenshot(path=str(artifacts / f"{theme}-messages.png"))
                page.set_viewport_size({"width": 390, "height": 844})
                for view, content in (("messages", ".composer textarea"), ("tasks", ".kb-board"),
                                      ("overview", ".super-agent-flow .canvas"), ("settings", ".sc-main"), ("projects", ".ps-card-grid")):
                    page.goto(url + "/#" + view)
                    expect(page.locator(content).first).to_be_visible()
                    assert page.evaluate("document.documentElement.scrollWidth <= innerWidth + 1"), (theme, view)
                    if artifacts: page.screenshot(path=str(artifacts / f"{theme}-390-{view}.png"))
                page.set_viewport_size({"width": 1600, "height": 1000})

            toggle = page.locator("#rail-theme")
            expect(toggle).to_have_attribute("data-theme-mode", "dark")
            toggle.click()
            expect(page.locator("#rail-theme-picker")).to_have_count(0)
            expect(page.locator("html")).to_have_attribute("data-theme-mode", "system")
            expect(toggle).to_have_attribute("data-theme-mode", "system")
            toggle.click()
            expect(page.locator("#rail-theme-picker")).to_have_count(0)
            expect(page.locator("html")).to_have_attribute("data-theme-mode", "light")
            expect(toggle).to_have_attribute("data-theme-mode", "light")
            page.reload()
            expect(page.locator("html")).to_have_attribute("data-theme-mode", "light")
            toggle.click()
            expect(page.locator("html")).to_have_attribute("data-theme-mode", "dark")
            expect(toggle).to_have_attribute("data-theme-mode", "dark")
            page.goto(url + "/#settings/runtime")
            page.get_by_role("radio", name="跟随系统").click()
            for theme in ["dark", "light"]:
                page.emulate_media(color_scheme=theme)
                expect(page.locator("html")).to_have_attribute("data-theme", theme)
            page.wait_for_function("""async () => {
                const {state} = await (await fetch('/api/state')).json();
                return state?.runs.length >= 6 && state.runs.every(run => run.state === 'done');
            }""", timeout=60000)
            assert not errors, errors
            browser.close()
        print("PASS: both themes, all surfaces, logo, direct theme cycle, version footer and real reload")
    finally:
        if process.poll() is None:
            process.stdin.write("stop\n"); process.stdin.flush()
            try: process.wait(timeout=20)
            except subprocess.TimeoutExpired:
                if os.name == "nt": subprocess.run(["taskkill", "/PID", str(process.pid), "/T", "/F"], capture_output=True)
                else: process.kill()
                process.wait()
