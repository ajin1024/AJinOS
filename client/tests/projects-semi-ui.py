# Prevent project cards from opening the wrong project, and keep filtering, editing and permission isolation
# on the first-level Project Space page; all writes are intercepted locally.
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
        reject_save = False
        page.on("pageerror", lambda error: errors.append(str(error)))

        def protect(route):
            req = route.request
            if req.method in ("GET", "HEAD"):
                route.continue_()
            elif req.url.endswith("/api/config") and req.method == "PUT":
                if reject_save:
                    route.fulfill(status=409, json={"error": "配置已更新，请重新载入后保存"})
                    return
                body = req.post_data_json
                writes.append(body)
                route.fulfill(json={"value": body["value"], "revision": "semi-ui-test", "profiles": {}, "restartRequired": False})
            else:
                route.abort()

        page.route("**/api/**", protect)
        page.goto(url)
        original = page.request.get(url.rstrip("/") + "/api/config").json()["value"]
        first_project = original["projects"][0]
        page.get_by_role("button", name="能力与沙箱", exact=True).click()
        expect(page).to_have_url(re.compile(r"#settings/projects$"))
        cards = page.get_by_role("region", name="项目卡片").get_by_role("button")
        expect(cards).to_have_count(len(original["projects"]))
        detail = page.get_by_role("region", name=first_project["name"], exact=True)
        expect(detail).not_to_be_visible()

        search = page.get_by_placeholder("搜索项目名称、目录或别名")
        search.fill(first_project["id"])
        expect(cards).to_have_count(1)
        card = cards.first
        card.focus()
        card.press("Enter")
        expect(detail).to_be_visible()
        expect(page).to_have_url(re.compile(rf"#settings/projects/{first_project['id']}$"))
        page.keyboard.press("Escape")
        expect(detail).not_to_be_visible()
        expect(card).to_be_focused()

        box = card.bounding_box()
        card.click(position={"x": box["width"] - 12, "y": box["height"] - 12})

        expect(detail).to_be_visible()
        expect(page.locator('input[name="name"]')).to_have_value(first_project["name"])
        page.locator('input[name="name"]').fill("取消的修改")
        page.get_by_role("button", name="取消修改", exact=True).click()
        expect(page.locator('input[name="name"]')).to_have_value(first_project["name"])
        page.locator('input[name="name"]').fill("Semi 界面测试")
        page.locator("#refresh-app").click()
        page.wait_for_timeout(500)
        expect(page.locator('input[name="name"]')).to_have_value("Semi 界面测试")
        page.get_by_role("button", name="保存项目", exact=True).click()
        expect(page.get_by_role("region", name="Semi 界面测试", exact=True)).to_be_visible()
        page.get_by_role("button", name="返回项目", exact=True).click()
        expect(page.get_by_placeholder("搜索项目名称、目录或别名")).to_have_value(first_project["id"])
        assert writes and "Semi 界面测试" == next(x for x in writes[-1]["value"]["projects"] if x["id"] == first_project["id"])["name"]
        saved = writes[-1]["value"]
        for project in original["projects"]:
            if project["id"] != first_project["id"]:
                assert next(x for x in saved["projects"] if x["id"] == project["id"]) == project
                rule = next(x for x in original["rules"]["rules"] if x["name"] == project["rule"])
                assert next(x for x in saved["rules"]["rules"] if x["name"] == project["rule"]) == rule
                assert saved["rules"]["agents"][rule["to"]] == original["rules"]["agents"][rule["to"]]
        target = next(x for x in saved["projects"] if x["id"] == first_project["id"])
        target_rule = next(x for x in saved["rules"]["rules"] if x["name"] == target["rule"])
        assert target["aliases"] == first_project["aliases"]
        assert target_rule == next(x for x in original["rules"]["rules"] if x["name"] == first_project["rule"])

        # Add project with progressive disclosure (auto-derived id & rule name)
        page.get_by_role("button", name="添加项目", exact=True).click()
        page.get_by_role("button", name="添加项目", exact=True).click()
        expect(page.get_by_text("请选择本地工作目录", exact=True)).to_be_visible()
        page.locator('input[name="cwd"]').fill("C:/workspace/semi-preview-test")
        reject_save = True
        page.get_by_role("button", name="添加项目", exact=True).click()
        expect(page.get_by_text("配置已更新，请重新载入后保存", exact=True)).to_be_visible()
        expect(page.locator('input[name="cwd"]')).to_have_value("C:/workspace/semi-preview-test")
        reject_save = False
        page.get_by_role("button", name="添加项目", exact=True).click()
        expect(page.locator(".ps-editor")).not_to_be_visible()
        created = next(x for x in writes[-1]["value"]["projects"] if x["id"] == "semi-preview-test")
        assert created["role"] == "project" and created["name"] == "semi-preview-test" and created["rule"]

        search.fill("不存在的项目-xyz")
        expect(page.get_by_text("没有匹配的项目", exact=True)).to_be_visible()
        search.fill("")
        page.get_by_role("combobox", name="筛选权限").click()
        page.get_by_role("option", name=re.compile("工作区编辑$")).click()
        expect(cards).to_have_count(1)
        expect(page.get_by_role("option", name=re.compile("工作区编辑$"))).to_have_count(0)
        page.get_by_role("combobox", name="筛选权限").click()
        page.get_by_role("option", name=re.compile("全部权限$")).click()
        expect(cards).to_have_count(len(original["projects"]) + 1)

        cards.first.click()
        page.keyboard.press("Escape")
        expect(page.locator(".ps-editor")).not_to_be_visible()

        for theme in ("dark", "light"):
            page.locator("#rail-theme").click()
            page.locator(f'[data-theme-choice="{theme}"]').click()
            expect(page.locator("html")).to_have_attribute("data-theme", theme)
        for width in (1280, 640, 390):
            page.set_viewport_size({"width": width, "height": 850})
            assert page.locator("#main").evaluate("el => el.scrollWidth <= el.clientWidth + 1")
            cards.first.click()
            workspace = page.locator(".ps-editor")
            expect(workspace.get_by_role("button", name="发起任务", exact=True)).to_be_in_viewport()
            bounds = workspace.bounding_box()
            assert 0 <= bounds["x"] and bounds["x"] + bounds["width"] <= width
            page.keyboard.press("Escape")
            expect(workspace).not_to_be_visible()
        assert not errors, errors
        browser.close()
        print("Semi project space: first-level page, progressive disclosure, filtering, editing, theme and responsive checks passed.")

if target_url:
    run_test(target_url)
else:
    with tempfile.TemporaryDirectory(prefix="studio-projects-ui-") as home:
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
