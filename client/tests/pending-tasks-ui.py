# Prevent pending-task selection or live updates from losing a reply across unified Task Center views.
# Prevent an empty board from filling the viewport with empty lanes or cutting off lanes at desktop widths.
# Prevent the removed demo tab from appearing in Task Center.
import json
import os
from contextlib import contextmanager
from pathlib import Path
from queue import Queue
import subprocess
import tempfile
from threading import Thread
from time import sleep

from playwright.sync_api import expect, sync_playwright


root = Path(__file__).resolve().parents[2]


@contextmanager
def temporary_studio_home():
    home = tempfile.TemporaryDirectory(prefix="studio-pending-ui-")
    try:
        yield home.name
    finally:
        for attempt in range(10):
            try:
                home.cleanup()
                break
            except PermissionError:
                if os.name != "nt" or attempt == 9:
                    raise
                sleep(0.5)


script = """
  import { startDemoStudio as startStudio } from './client/tests/studio-fixtures.mjs';
  const studio = await startStudio({ home: process.argv[1], port: 0, autostart: true, businessTasks: true,
    gatewayModel: async () => ({ confirmed: true, reason: '隔离测试目标明确' }) });
  console.log(JSON.stringify({url:studio.url}));
  process.stdin.once('data', async () => { await studio.close(); process.exit(0); });
"""
with temporary_studio_home() as home:
    with (Path(home) / "stderr.log").open("w", encoding="utf-8") as stderr:
        process = subprocess.Popen(
            ["node", "--input-type=module", "-e", script, home], cwd=root,
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
                    page = browser.new_page(viewport={"width": 1440, "height": 920})
                    errors = []
                    page.on("pageerror", lambda error: errors.append(str(error)))
                    page.goto(url)
                    page.wait_for_selector(".fc-canvas")
                    expect(page).to_have_title("AJinOS")
                    expect(page.get_by_role("link", name="AJinOS")).to_be_visible()
                    expect(page.locator("header #nav")).to_be_visible()
                    expect(page.locator(".sidebar")).to_have_count(0)
                    page.locator('#nav [data-view="tasks"]').click()
                    expect(page.get_by_role("tab", name="演示记录", exact=True)).to_have_count(0)
                    board = page.get_by_role("region", name="任务看板")
                    expect(board.get_by_text("暂无任务", exact=True)).to_be_visible()
                    expect(board.locator("[data-board-col]")).to_have_count(0)
                    assert page.locator("#task-search").bounding_box()["y"] == page.locator(
                        "#task-status-filter"
                    ).bounding_box()["y"]
                    for index in (1, 2):
                        response = page.request.post(
                            url + "/api/messages", headers={"x-studio-action": "1"},
                            data={"id": f"pending-{index}", "topic": f"pending-topic-{index}",
                                  "project": "content", "text": f"待办演示任务 {index}"},
                        )
                        assert response.ok, response.text()
                    page.wait_for_function("""async () => {
                      const snapshot = await (await fetch('/api/state')).json();
                      return snapshot.state.cards.filter(card => card.kind === 'ask').length === 2;
                    }""", timeout=30000)

                    # Verify cards land in the "待审核" column and "[ 开始处理 › ]" opens the detail drawer
                    review_col = page.locator('[data-board-col="review"]')
                    expect(review_col.locator(".kb-card")).to_have_count(2, timeout=10000)
                    expect(board.locator("[data-board-col]")).to_have_count(7)
                    assert board.evaluate("el => el.scrollWidth <= el.clientWidth + 1")
                    page.locator("#task-search").fill("找不到的任务")
                    expect(board.get_by_text("没有匹配的任务", exact=True)).to_be_visible()
                    expect(board.locator("[data-board-col]")).to_have_count(0)
                    board.get_by_role("button", name="清除筛选").click()
                    expect(page.locator("#task-search")).to_have_value("")
                    page.set_viewport_size({"width": 390, "height": 800})
                    assert board.evaluate("el => el.scrollWidth > el.clientWidth")
                    assert page.locator("#main").evaluate("el => el.scrollWidth <= el.clientWidth + 1")
                    page.set_viewport_size({"width": 1440, "height": 920})
                    review_col.get_by_role("button", name="开始处理 ›").click()
                    expect(page.locator("#drawer")).to_be_visible()
                    page.keyboard.press("Escape")
                    # Switch to split list view to verify list/drafts/search/reply flows
                    page.locator("#task-view-list").click()
                    status = page.get_by_role("combobox", name="任务状态")
                    expect(status).to_have_value("all")
                    expect(page.get_by_role("region", name="任务详情")).to_be_visible()
                    queue = page.get_by_role("region", name="任务列表")
                    detail = page.get_by_role("region", name="任务详情")
                    first = queue.get_by_role("button", name="待办演示任务 1", exact=False)
                    second = queue.get_by_role("button", name="待办演示任务 2", exact=False)
                    expect(first).to_be_visible(timeout=10000)
                    first.click()
                    expect(detail.get_by_role("heading", name="待办演示任务 1")).to_be_visible()
                    detail.get_by_role("tab", name="原始需求").click()
                    expect(detail.get_by_role("region", name="原始需求")).to_contain_text("待办演示任务 1")
                    detail.get_by_role("tab", name="执行记录").click()
                    detail.get_by_role("button", name="结果与输出").click()
                    page.locator("#drawer").get_by_role("tab", name="执行记录").click()
                    expect(page.locator("#drawer .task-workflow")).to_be_visible()
                    page.keyboard.press("Escape")
                    detail.get_by_role("tab", name="处理与对话").click()
                    detail.get_by_role("radio", name="其他回答").check()
                    detail.get_by_role("textbox", name="你的回答").fill("先核对原始记录")
                    second.click()
                    expect(detail.get_by_role("heading", name="待办演示任务 2")).to_be_visible()
                    first.click()
                    expect(detail.get_by_role("textbox", name="你的回答")).to_have_value("先核对原始记录")
                    page.locator("#task-search").fill("演示任务 1")
                    expect(second).to_have_count(0)
                    page.locator("#task-search").clear()

                    card_id = detail.locator("form").get_attribute("data-card-id")
                    # Switch to unified "待我处理" view and verify draft is preserved and can be submitted there
                    page.locator("#task-scope-todo").click()
                    todo_queue = page.get_by_role("region", name="待我处理列表")
                    expect(todo_queue.get_by_role("button")).to_have_count(2)
                    todo_first = todo_queue.get_by_role("button", name="待办演示任务 1", exact=False)
                    todo_first.click()
                    expect(detail.get_by_role("textbox", name="你的回答")).to_have_value("先核对原始记录")
                    if os.environ.get("STUDIO_TEST_SCREENSHOT"):
                        page.screenshot(path=os.environ["STUDIO_TEST_SCREENSHOT"])
                    detail.get_by_role("button", name="提交答复").click()
                    expect(todo_first).to_have_count(0, timeout=15000)
                    expect(todo_queue.get_by_role("button", pressed=True)).to_have_count(1)
                    page.locator("#inbox-history").click()
                    page.get_by_role("region", name="最近处理的卡片").locator(f'[data-id="{card_id}"]').click()
                    expect(detail).to_contain_text("先核对原始记录")

                    page.locator("#task-scope-business").click()
                    page.get_by_role("combobox", name="任务状态").select_option("awaiting_human")
                    expect(detail.get_by_role("heading", name="待办演示任务 2")).to_be_visible()
                    page.set_viewport_size({"width": 390, "height": 800})
                    main = page.locator("#main")
                    assert main.evaluate("el => el.scrollWidth <= el.clientWidth + 1"), main.evaluate(
                        "el => [el.clientWidth, el.scrollWidth]"
                    )
                    detail.get_by_role("radio", name="结束演示").check()
                    detail.get_by_role("button", name="提交答复").click()
                    expect(page.get_by_text("没有待你处理的任务", exact=True)).to_be_visible(timeout=15000)
                    expect(detail).to_be_visible()
                    cards = page.request.get(url + "/api/state").json()["state"]["recentCards"]
                    assert any(card.get("answer") == "先核对原始记录" for card in cards), cards
                    assert any(card.get("choice") == 1 for card in cards), cards
                    assert not errors, errors
                    page.wait_for_function("""async () => {
                      const { state } = await (await fetch('/api/state')).json();
                      return state.runs.every(run => run.state === 'done');
                    }""", timeout=30000)
                    print("Unified Task Center and pending tasks passed: switching, drafts, search, real replies and narrow layout.")
                finally:
                    browser.close()
        finally:
            if process.poll() is None:
                process.stdin.write("stop\n")
                process.stdin.flush()
                process.wait(timeout=45)
