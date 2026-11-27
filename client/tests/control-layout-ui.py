# Prevent the approved Studio layouts from overlapping, overflowing or hiding legacy views in either theme.
# Prevent the chat overlay from covering acceptance controls and verify that cold start and Router actions use live services.
import os
from pathlib import Path
import re
from tempfile import TemporaryDirectory

from playwright.sync_api import expect, sync_playwright
from studio_browser import running_studio, state, submit, wait_online


def check_viewport(page):
    problems = page.evaluate("""() => {
      const root = document.documentElement;
      const controls = [...document.querySelectorAll(
        '#nav .nav-item, #nav .rail-control, .mc-stage .view-header, .mc-stage .composer, .mc-stage .thread-drawer, .studio-operation-tabs'
      )].filter(el => el.checkVisibility());
      return [
        ...(root.scrollWidth > innerWidth ? ['horizontal page overflow'] : []),
        ...controls.flatMap(el => {
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0 && r.left >= -1 && r.right <= innerWidth + 1 &&
            r.top >= -1 && r.bottom <= innerHeight + 1 ? [] : [(el.id || el.className) + ': ' + JSON.stringify(r)];
        })
      ];
    }""")
    assert not problems, problems


def capture(page, target, name):
    check_viewport(page)
    page.screenshot(path=target / f"{name}.png", animations="disabled")


with running_studio("studio-control-layout-") as url, TemporaryDirectory(prefix="studio-edge-shots-") as temporary, sync_playwright() as playwright:
    target = Path(os.environ.get("STUDIO_UI_SCREENSHOTS", temporary))
    browser = playwright.chromium.launch(channel="msedge", headless=True)
    page = browser.new_page(base_url=url, viewport={"width": 1440, "height": 900}, color_scheme="light", reduced_motion="reduce")
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.on("console", lambda message: errors.append(message.text) if message.type == "error" else None)
    page.goto(url)
    wait_online(page)
    expect(page.get_by_role("heading", name="任务处理流程", exact=True)).to_be_visible()
    rail = page.get_by_role("navigation", name="主导航")
    expect(rail.locator(".nav-item")).to_have_count(3)
    assert rail.locator(".nav-item").evaluate_all("items => items.map(item => item.getAttribute('aria-label'))") == ["工作台", "对话", "能力与沙箱"]
    expect(rail.get_by_role("button", name="工作台")).to_have_attribute("aria-current", "page")
    assert round(rail.bounding_box()["width"]) == 52
    controls = rail.get_by_role("group", name="应用控制")
    expect(controls.get_by_role("button")).to_have_count(3)
    assert controls.bounding_box()["y"] + controls.bounding_box()["height"] >= 870
    expect(page.locator("#status-capsule")).to_have_text("引擎在线")
    capture(page, target, "light-empty")
    engine = controls.locator("#engine-power")
    expect(engine).to_have_attribute("title", "引擎在线")
    engine.click()
    stop = page.get_by_role("dialog", name="停止引擎")
    expect(stop).to_be_visible()
    stop.get_by_role("button", name="取消").click()
    expect(stop).to_be_hidden()
    expect(engine).to_have_attribute("data-engine-state", "online")
    engine.click()
    stop.get_by_role("button", name="停止引擎", exact=True).click()
    expect(engine).to_have_accessible_name("启动引擎", timeout=30000)
    page.goto(url + "/#projects")
    expect(page.get_by_text("中台暂未连接", exact=False)).to_have_count(1)
    page.get_by_role("button", name="和 AJinOS 总管沟通").click()
    chat = page.get_by_role("dialog", name="AJinOS 总管沟通")
    expect(chat.get_by_text("引擎离线，启动引擎后即可发送。")).to_be_visible()
    chat.get_by_role("textbox", name="任务说明").fill("离线时的草稿")
    expect(chat.get_by_role("button", name="发送", exact=True)).to_be_disabled()
    capture(page, target, "light-offline-chat")
    chat.get_by_role("textbox", name="任务说明").fill("")
    page.keyboard.press("Escape")
    expect(chat).to_have_count(0)
    page.locator("#status-capsule").click()
    expect(engine).to_have_attribute("data-engine-state", "online", timeout=30000)
    controls.get_by_role("button", name="版本与更新").click()
    versions = page.get_by_role("dialog", name="版本与更新")
    expect(versions).to_be_visible()
    page.keyboard.press("Escape")
    expect(versions).to_be_hidden()

    title = "订单发货前核查验收依据和执行记录并直接完成"
    review = submit(page, title, project="orders")
    submit(page, "需要本人决定是否继续", project="content")
    submit(page, "无法唯一判断这条请求的归属")
    submit(page, "/plan 跨项目先核对订单然后整理内容")
    submit(page, "今天有哪些待处理")
    page.goto(url + "/#messages")
    expect(page.get_by_text("只读简报 · 未开单")).to_be_visible()
    expect(page.locator(".receipt").filter(has_text=title).get_by_role("button", name="通过验收")).to_be_enabled(timeout=30000)

    for theme in ("light", "dark"):
        if theme == "dark":
            for _ in range(3):
                if page.locator("html").get_attribute("data-theme-mode") == "dark":
                    break
                rail.locator("#rail-theme").click()
        expect(page.locator("html")).to_have_attribute("data-theme", theme)
        page.goto(url + "/#messages")
        expect(page.locator(".composer")).to_be_visible()
        expect(page.locator(".floating-chat-fab")).to_have_count(0)
        expect(page.locator(".plan")).to_be_visible()
        assert round(page.locator(".mc-stage .dialog-sidebar").bounding_box()["width"]) == 268
        capture(page, target, f"{theme}-chat")

        page.goto(url + "/#messages/" + review["topic"])
        expect(page.get_by_text("Thread 直通 · 跳过路由")).to_be_visible()
        page.locator(".view-header").get_by_role("button", name="展开详情").click()
        drawer = page.get_by_role("complementary", name="工单详情")
        expect(drawer.get_by_text("执行轮次与用量")).to_be_visible()
        expect(drawer.get_by_role("button", name="通过验收")).to_be_visible()
        assert round(drawer.bounding_box()["width"]) == 368
        capture(page, target, f"{theme}-thread")
        page.get_by_role("button", name="收起详情").click()
        expect(drawer).to_have_count(0)

        page.goto(url + "/#inbox")
        expect(page.get_by_role("region", name="待拍板")).to_be_visible(timeout=30000)
        expect(page.get_by_role("region", name="待验收")).to_be_visible()
        expect(page.get_by_role("region", name="待澄清与失败请求")).to_be_visible()
        capture(page, target, f"{theme}-inbox")

        page.goto(url + "/#tasks")
        expect(rail.get_by_role("button", name="工作台", exact=True)).to_have_attribute("aria-current", "page")
        search = page.locator("#task-search")
        expect(search).to_be_visible()
        assert search.evaluate("""el => {
          const css = getComputedStyle(el), ctx = document.createElement('canvas').getContext('2d');
          ctx.font = css.font;
          return el.clientWidth - parseFloat(css.paddingLeft) - parseFloat(css.paddingRight)
            >= ctx.measureText(el.placeholder).width;
        }""")
        expect(page.locator(".kb-board")).to_be_visible()
        expect(page.locator(".kb-board [data-board-col]")).to_have_count(4)
        capture(page, target, f"{theme}-operations")
        page.get_by_role("button", name="协作计划").click()
        expect(page.locator(".studio-plan-view .plan")).to_be_visible()
        page.goto(url + "/#overview")
        expect(page.get_by_role("button", name="任务总览")).to_have_attribute("aria-pressed", "true")
        flow = page.get_by_role("region", name="任务处理流程图")
        expect(flow.locator(".lane-head h3")).to_have_text(["任务入口", "消息分派", "项目与执行器", "待我处理与完成"])
        expect(flow.locator(".wires path").first).to_be_visible()
        expect(page.locator(".composer")).to_have_count(0)
        pending = flow.get_by_role("region", name="待验收").get_by_role("button", name=re.compile(title))
        expect(pending).to_be_visible(timeout=30000)
        capture(page, target, f"{theme}-flow")
        pending.click()
        drawer = page.get_by_role("complementary", name="工单详情")
        expect(drawer.get_by_text("验收标准逐项依据")).to_be_visible()
        expect(drawer.locator(".drawer-head h2")).to_have_text(title)
        assert drawer.locator(".drawer-head h2").evaluate("el => el.scrollHeight <= el.clientHeight + 1")
        expect(drawer.get_by_role("button", name="查看原对话")).to_be_visible()
        expect(drawer.get_by_role("button", name="通过验收")).to_be_enabled()
        expect(flow.locator(".wire-group.hot").first).to_be_visible()
        expect(flow.locator('[data-node="chat"]')).to_have_attribute("data-on-path", "true")
        expect(flow.locator('[data-node="github"]')).to_have_attribute("data-on-path", "false")
        fab = page.get_by_role("button", name="和 AJinOS 总管沟通")
        assert fab.bounding_box()["x"] + fab.bounding_box()["width"] < drawer.bounding_box()["x"]
        fab.click()
        expect(chat).to_be_visible()
        assert chat.bounding_box()["x"] + chat.bounding_box()["width"] < drawer.bounding_box()["x"]
        assert round(chat.bounding_box()["width"]) == 400
        assert round(chat.bounding_box()["height"]) == 540
        expect(drawer.get_by_role("button", name="通过验收")).to_be_in_viewport()
        capture(page, target, f"{theme}-flow-trace-chat")
        page.keyboard.press("Escape")
        expect(chat).to_have_count(0)
        expect(drawer).to_be_visible()
        drawer.get_by_role("button", name="关闭详情").click()
        page.get_by_role("button", name="查看任务路径", exact=True).click()
        menu = page.get_by_role("region", name="选择要查看路径的任务")
        menu.get_by_role("searchbox").fill(title)
        menu.get_by_role("button", name=re.compile(title)).click()
        expect(drawer).to_be_visible()
        drawer.get_by_role("button", name="关闭详情").click()
        expect(flow.locator(".wire-group.hot")).to_have_count(0)
        flow.get_by_role("region", name="待拍板").get_by_role("button", name=re.compile("继续执行演示验证吗")).click()
        expect(drawer.get_by_role("button", name="提交答复")).to_be_visible()
        drawer.get_by_role("button", name="关闭详情").click()

        page.goto(url + "/#projects")
        expect(rail.get_by_role("button", name="能力与沙箱")).to_have_attribute("aria-current", "page")
        settings = page.get_by_role("navigation", name="能力与沙箱导航")
        expect(settings.get_by_role("button")).to_have_text([
            "项目领地（沙箱）", "执行器与三角色", "长期记忆档案", "规则与定时", "来源与通知",
            "飞书群聊采集", "运行环境与引擎", "引擎日志", "高级 JSON 与版本",
        ])
        expect(settings.locator('[data-settings-section="projects"]')).to_have_attribute("aria-current", "page")
        capture(page, target, f"{theme}-settings")

        for bookmark, section in (
            ("#settings", "projects"), ("#projects/orders", "projects"), ("#rules", "rules"),
            ("#connections", "connections"), ("#agents", "agents"), ("#feishu-groups", "feishu"), ("#memory", "memory"),
        ):
            page.goto(url + "/" + bookmark)
            expect(settings.locator(f'[data-settings-section="{section}"]')).to_have_attribute("aria-current", "page")
        page.set_viewport_size({"width": 390, "height": 900})
        toggle = page.get_by_role("button", name=re.compile("能力与沙箱导航"))
        expect(toggle).to_be_visible()
        toggle.click()
        expect(settings).to_be_visible()
        toggle.click()
        page.set_viewport_size({"width": 1440, "height": 900})

        page.goto(url + "/#messages")
        expect(page.locator("#refresh-app")).to_have_count(0)

    page.set_viewport_size({"width": 1280, "height": 720})
    page.goto(url + "/")
    expect(page.get_by_role("heading", name="任务处理流程")).to_be_visible()
    capture(page, target, "1280-flow")
    page.keyboard.press("Alt+Shift+A")
    expect(chat).to_be_visible()
    field = chat.get_by_role("textbox", name="任务说明")
    expect(field).to_be_focused()
    before = state(page)["state"].get("tickets", [])
    field.fill("/ask 今天有哪些待处理")
    with page.expect_response(lambda response: response.url.endswith("/api/router/message") and response.request.method == "POST") as reply:
        field.press("Enter")
    assert reply.value.ok and reply.value.json()["kind"] == "answer"
    expect(chat.get_by_text("只读简报 · 未开单")).to_have_count(2)
    assert before == state(page)["state"].get("tickets", [])
    expect(page.get_by_text(re.compile("快捷问答 2"))).to_be_visible()
    capture(page, target, "1280-chat")
    chat.get_by_role("button", name="打开完整对话").click()
    expect(page).to_have_url(url + "/#messages")
    expect(page.locator(".floating-chat-fab")).to_have_count(0)
    capture(page, target, "1280-messages")
    for hash_value, selector in (("#tasks", ".kb-board"), ("#tasks/plans", ".studio-plan-view .plan"), ("#projects", ".sc-main")):
        page.goto(url + "/" + hash_value)
        expect(page.locator(selector).first).to_be_visible()
        capture(page, target, f"1280-{hash_value.lstrip('#').replace('/', '-')}")
    page.goto(url + "/#overview")
    flow.get_by_role("region", name="待验收").get_by_role("button", name=re.compile(title)).click()
    drawer.get_by_role("button", name="通过验收").click()
    expect(drawer).to_have_count(0)
    expect(flow.locator('[data-node="signed"] .count')).to_have_text("1")
    closed = next(ticket for ticket in state(page)["state"]["tickets"] if ticket["state"] == "closed")
    assert page.request.get(f"/api/tickets/{closed['id']}").json()["outcome"] == "completed"
    page.get_by_role("button", name="和 AJinOS 总管沟通").click()
    field.fill("/plan 核查订单后再同步内容")
    field.press("Enter")
    start = chat.get_by_role("button", name="确认启动计划").last
    expect(start).to_be_enabled(timeout=20000)
    with page.expect_response(lambda response: response.url.endswith("/start") and response.request.method == "POST") as started:
        start.click()
    assert started.value.ok and started.value.json()["plan"]["status"] == "running"
    expect(flow.get_by_role("button", name=re.compile("跨项目协作.*跨项目交接"))).to_be_visible()
    page.keyboard.press("Escape")
    page.locator(".studio-pending-capsule").click()
    expect(page).to_have_url(url + "/#inbox")
    assert not errors, errors
    browser.close()

print("Edge 1440x900 light/dark and 1280x720: live flow, tracing, drawer, floating Router chat and navigation passed")
