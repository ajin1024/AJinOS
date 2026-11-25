# Prevent the message layout from separating a new draft from its starter actions or hiding execution details.
import base64
import json
import os
from pathlib import Path
from queue import Queue
import subprocess
import sys
import tempfile
from threading import Thread

from playwright.sync_api import expect, sync_playwright


root = Path(__file__).resolve().parents[2]
script = """
  import { startDemoStudio as startStudio } from './client/tests/studio-fixtures.mjs';
  const studio = await startStudio({ home: process.argv[1], port: 0, autostart: true,
    gatewayModel: async () => ({ description: '测试截图' }) });
  console.log(JSON.stringify({ url: studio.url }));
  process.stdin.once('data', async () => { await studio.close(); process.exit(0); });
"""
png = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jB1sAAAAASUVORK5CYII="
)

with tempfile.TemporaryDirectory(prefix="studio-messages-ui-") as temp:
    with (Path(temp) / "studio.log").open("w+", encoding="utf-8") as stderr:
        process = subprocess.Popen(
            ["node", "--input-type=module", "-e", script, temp], cwd=root,
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=stderr, text=True, encoding="utf-8",
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
        )
        ready = Queue()
        Thread(target=lambda: ready.put(process.stdout.readline()), daemon=True).start()
        try:
            line = ready.get(timeout=45)
            if not line:
                stderr.seek(0)
                raise RuntimeError(stderr.read())
            url = json.loads(line)["url"]
            with sync_playwright() as p:
                browser = p.chromium.launch(channel="msedge", headless=True)
                page = browser.new_page(viewport={"width": 1484, "height": 960})
                errors = []
                page.on("pageerror", lambda error: errors.append(str(error)))
                page.goto(url + "/#messages")
                page.wait_for_function("async () => (await (await fetch('/api/state')).json()).connected")

                composer = page.locator(".mc-composer")
                timeline = page.locator(".mc-timeline")
                sidebar = page.get_by_role("complementary", name="会话列表")
                draft = composer.locator("textarea")
                first_starter = page.get_by_role("button", name="把订单列表加上批量发货")
                starter = page.get_by_role("button", name="整理一份本周项目进展")
                heading = page.get_by_role("heading", name="今天想做什么？")
                expect(heading).to_be_visible()
                expect(page.get_by_role("button", name="对话列表")).to_be_hidden()
                expect(page.get_by_role("button", name="返回对话")).to_be_hidden()
                for viewport in ({"width": 1484, "height": 960}, {"width": 390, "height": 680}):
                    page.set_viewport_size(viewport)
                    expect(draft).to_be_in_viewport()
                    expect(starter).to_be_in_viewport()
                    heading_box = heading.bounding_box()
                    composer_box = composer.bounding_box()
                    starter_box = first_starter.bounding_box()
                    assert 0 <= composer_box["y"] - heading_box["y"] - heading_box["height"] <= 48
                    assert 0 <= starter_box["y"] - composer_box["y"] - composer_box["height"] <= 56
                page.set_viewport_size({"width": 1484, "height": 960})
                starter.click()
                expect(draft).to_have_value("整理一份本周项目进展")
                composer.get_by_role("combobox", name="目标项目").click()
                page.get_by_role("option", name="订单服务 · 演示").click()
                composer.get_by_role("button", name="高级选项").click()
                composer.get_by_label("我确定目标，跳过需求确认").check()
                composer.locator('input[type="file"]').set_input_files(
                    {"name": "proof.png", "mimeType": "image/png", "buffer": png}
                )
                draft.fill("核对批量发货并直接完成")
                draft.press("Shift+Enter")
                expect(draft).to_have_value("核对批量发货并直接完成\n")
                expect(composer.get_by_role("button", name="发送")).to_be_enabled()
                draft.press("Enter")
                expect(timeline.get_by_text("核对批量发货并直接完成", exact=True)).to_be_visible(timeout=20000)
                timeline.get_by_role("button", name="proof.png").click()
                lightbox = page.locator(".mc-lightbox-image")
                expect(lightbox).to_be_visible()
                expect(lightbox).to_have_js_property("naturalWidth", 1)
                page.keyboard.press("Escape")

                execution = page.get_by_role("complementary", name="执行信息")
                expect(execution).to_contain_text("分析执行器", timeout=25000)
                expect(timeline.get_by_role("button", name="验收通过")).to_be_visible(timeout=30000)
                expect(timeline.get_by_role("button", name="补充返工")).to_be_visible()
                expect(timeline.get_by_role("button", name="关闭任务")).to_be_visible()
                assert execution.bounding_box()["x"] > timeline.bounding_box()["x"]
                sidebar.get_by_role("button", name="待处理", exact=False).click()
                expect(sidebar.locator(".mc-conversation")).to_have_count(1)
                search = sidebar.get_by_role("searchbox", name="搜索对话")
                search.fill("无匹配的关键词")
                expect(sidebar.locator(".mc-conversation")).to_have_count(0)
                search.fill("")
                expect(sidebar.locator(".mc-conversation")).to_have_count(1)

                execution.get_by_role("button", name="查看执行详情").click()
                expect(page.locator("#drawer")).to_be_visible()
                page.keyboard.press("Escape")
                expect(page.locator("#drawer")).not_to_be_visible()
                if len(sys.argv) > 1:
                    page.locator(".mc-head-title h1").click()
                    page.screenshot(path=sys.argv[1])

                page.set_viewport_size({"width": 740, "height": 900})
                expect(execution.get_by_role("button", name="查看执行详情")).to_be_visible()
                timeline.get_by_role("button", name="验收通过").click()
                expect(page.get_by_role("heading", name="核对批量发货并直接完成")).to_be_visible()
                expect(page.locator(".mc-conversation-head")).to_contain_text("已结束")
                expect(timeline.get_by_role("button", name="验收通过")).to_have_count(0)
                page.get_by_role("button", name="对话列表").click()
                sidebar.get_by_role("button", name="已结束").click()
                expect(sidebar.locator(".mc-conversation")).to_have_count(1)
                page.locator("#status-capsule").click()
                page.locator('[data-theme-choice="dark"]').click()
                expect(page.locator("html")).to_have_attribute("data-theme", "dark")
                expect(page.locator(".mc-page")).to_have_css("background-color", "rgb(29, 32, 38)")
                assert not errors, errors
                browser.close()
        finally:
            if process.poll() is None:
                try:
                    process.communicate("shutdown\n", timeout=30)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.communicate(timeout=10)
