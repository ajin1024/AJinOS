# Keep the project prompt, floating composer, project tree and acceptance actions usable at both widths.
import base64
import json
import os
from pathlib import Path
from queue import Queue
import subprocess
import sys
from studio_home import studio_home
from threading import Thread

from playwright.sync_api import expect, sync_playwright


root = Path(__file__).resolve().parents[2]
script = """
  import { startDemoStudio as startStudio } from './client/tests/studio-fixtures.mjs';
  const studio = await startStudio({ home: process.argv[1], port: 0, autostart: true,
    gatewayModel: async (kind) => kind === 'route'
      ? {project:'orders', flow:'default', complexity:'simple', certain:true, reason:'任务与订单项目匹配'}
      : {description:'测试截图'} });
  console.log(JSON.stringify({ url: studio.url }));
  process.stdin.once('data', async () => { await studio.close(); process.exit(0); });
"""
png = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jB1sAAAAASUVORK5CYII="
)

with studio_home("studio-messages-ui-") as temp:
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
                heading = page.locator("h1.mc-start-title")
                expect(heading).to_be_visible()
                expect(page.get_by_role("button", name="对话列表")).to_be_hidden()
                expect(page.get_by_role("button", name="返回对话")).to_be_hidden()
                for viewport in ({"width": 1484, "height": 960}, {"width": 390, "height": 680}):
                    page.set_viewport_size(viewport)
                    expect(draft).to_be_in_viewport()
                    expect(heading).to_be_in_viewport()
                    heading_box = heading.bounding_box()
                    composer_box = composer.bounding_box()
                    assert heading_box["y"] + heading_box["height"] < composer_box["y"]
                    assert composer_box["y"] + composer_box["height"] > viewport["height"] * 0.8
                page.set_viewport_size({"width": 1484, "height": 960})
                project = heading.get_by_role("combobox", name="选择发起项目")
                expect(project).to_have_value("")
                project.select_option("orders")
                expect(composer).to_contain_text("订单服务")
                draft.fill("订单项目的定向草稿")
                page.get_by_role("button", name="新对话", exact=True).click()
                expect(project).to_have_value("")
                expect(draft).to_have_value("")
                sidebar.get_by_role("button").filter(has_text="订单项目的定向草稿").click()
                expect(draft).to_have_value("订单项目的定向草稿")
                expect(composer.get_by_role("combobox", name="目标项目")).to_have_value("orders")
                composer.get_by_role("button", name="高级选项").click()
                composer.get_by_label("我确定目标，跳过需求确认").check()
                composer.locator('input[type="file"]').set_input_files(
                    {"name": "proof.png", "mimeType": "image/png", "buffer": png}
                )
                draft.evaluate("""(field, bytes) => {
                    const clipboardData = new DataTransfer();
                    clipboardData.items.add(new File([new Uint8Array(bytes)], "pasted.png", {type: "image/png"}));
                    field.dispatchEvent(new ClipboardEvent("paste", {clipboardData, bubbles: true}));
                }""", list(png))
                expect(composer.locator(".mc-composer-thumb.done")).to_have_count(2)
                draft.fill("核对批量发货并直接完成")
                draft.press("Shift+Enter")
                expect(draft).to_have_value("核对批量发货并直接完成\n")
                expect(composer.get_by_role("button", name="发送")).to_be_enabled()
                draft.press("Enter")
                expect(timeline.get_by_text("核对批量发货并直接完成", exact=True)).to_be_visible(timeout=20000)
                expect(timeline.get_by_role("button", name="pasted.png")).to_be_visible()
                timeline.get_by_role("button", name="proof.png").click()
                lightbox = page.locator(".mc-lightbox-image")
                expect(lightbox).to_be_visible()
                expect(lightbox).to_have_js_property("naturalWidth", 1)
                page.keyboard.press("Escape")

                execution = page.locator("details.mc-execution")
                execution.locator("summary").click()
                expect(execution).to_contain_text("分析执行器", timeout=25000)
                expect(timeline.get_by_role("button", name="通过验收")).to_be_visible(timeout=30000)
                expect(timeline.get_by_role("button", name="打回修改")).to_be_visible()
                acceptance = timeline.locator(".mc-acceptance").filter(has=page.get_by_role("button", name="通过验收"))
                expect(acceptance).to_have_css("background-color", "rgb(253, 243, 227)")
                expect(timeline.get_by_role("button", name="关闭任务")).to_be_visible()
                sidebar.get_by_role("button", name="筛选会话").click()
                sidebar.get_by_role("button", name="待验收", exact=True).click()
                expect(sidebar.locator(".mc-conversation")).to_have_count(1)
                sidebar.get_by_role("button", name="搜索对话").click()
                search = sidebar.get_by_role("searchbox", name="搜索对话")
                search.fill("无匹配的关键词")
                expect(sidebar.locator(".mc-conversation")).to_have_count(0)
                search.fill("")
                expect(sidebar.locator(".mc-conversation")).to_have_count(1)
                sidebar.get_by_role("button", name="置顶 核对批量发货并直接完成").click()
                expect(sidebar.get_by_role("heading", name="置顶", exact=True)).to_be_visible()

                execution.get_by_role("button", name="查看执行详情").click()
                expect(page.locator("#drawer")).to_be_visible()
                page.keyboard.press("Escape")
                expect(page.locator("#drawer")).not_to_be_visible()
                if len(sys.argv) > 1:
                    page.locator(".mc-head-title h1").click()
                    page.screenshot(path=sys.argv[1])

                page.set_viewport_size({"width": 740, "height": 900})
                expect(execution.get_by_role("button", name="查看执行详情")).to_be_visible()
                timeline.get_by_role("button", name="通过验收").click()
                expect(page.get_by_role("heading", name="核对批量发货并直接完成")).to_be_visible()
                expect(page.locator(".mc-conversation-head")).to_contain_text("已结束")
                expect(timeline.get_by_role("button", name="通过验收")).to_have_count(0)
                page.get_by_role("button", name="对话列表").click()
                sidebar.get_by_role("button", name="已结束").click()
                expect(sidebar.locator(".mc-conversation")).to_have_count(1)
                page.locator("#status-capsule").click()
                page.locator('[data-theme-choice="dark"]').click()
                expect(page.locator("html")).to_have_attribute("data-theme", "dark")
                expect(page.locator(".mc-main")).to_have_css("background-color", "rgb(27, 31, 44)")
                page.set_viewport_size({"width": 1484, "height": 960})
                page.get_by_role("button", name="新对话", exact=True).click()
                expect(project).to_have_value("")
                composer.get_by_role("button", name="高级选项").click()
                composer.get_by_label("我确定目标，跳过需求确认").check()
                draft.fill("核对订单并直接完成")
                with page.expect_response(lambda response: response.url.endswith("/api/messages") and
                                          response.request.method == "POST") as submitted:
                    draft.press("Enter")
                assert not submitted.value.request.post_data_json.get("project")
                assert submitted.value.json().get("project") == "orders", submitted.value.text()
                expect(timeline.get_by_text("核对订单并直接完成", exact=True)).to_be_visible()
                assert not errors, errors
                browser.close()
        finally:
            if process.poll() is None:
                try:
                    process.communicate("shutdown\n", timeout=30)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.communicate(timeout=10)
