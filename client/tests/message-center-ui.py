# Prevent the read-only record, Inbox, Thread continuation, attachments and plan actions from losing their real backend bindings.
import base64
import re

from playwright.sync_api import expect, sync_playwright
from studio_browser import running_studio, state, submit, wait_online


PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jB1sAAAAASUVORK5CYII="
)


with running_studio("studio-messages-ui-") as url, sync_playwright() as playwright:
    browser = playwright.chromium.launch(channel="msedge", headless=True)
    page = browser.new_page(base_url=url, viewport={"width": 1440, "height": 900})
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.goto(url)
    wait_online(page)
    expect(page.get_by_role("heading", name="任务流转")).to_be_visible()
    page.get_by_role("navigation", name="主导航").get_by_role("button", name="对话").click()
    expect(page.get_by_role("heading", name="AJinOS 总管", exact=True)).to_be_visible()
    sidebar = page.get_by_role("complementary", name="对话列表")
    expect(page.locator(".composer")).to_have_count(0)

    before = state(page)["state"].get("tickets", [])
    brief = submit(page, "今日简报")
    assert brief["kind"] == "answer", brief
    expect(page.get_by_text("只读简报 · 未开单", exact=True)).to_be_visible(timeout=15000)
    assert before == state(page)["state"].get("tickets", [])
    page.reload()
    expect(page.get_by_text("只读简报 · 未开单", exact=True)).to_be_visible(timeout=15000)

    title = "核对订单并直接完成"
    uploaded = page.request.post(url + "/api/attachments", headers={"x-studio-action": "1"}, data={
        "dataBase64": base64.b64encode(PNG).decode(), "filename": "proof.png",
    })
    assert uploaded.ok, uploaded.text()
    receipt = submit(page, title, project="orders", attachments=[uploaded.json()["id"]])
    assert receipt["kind"] == "task" and receipt["project"] == "orders", receipt
    topic = receipt["topic"]
    page.reload()
    expect(page).to_have_url(url + "/#messages")
    card = page.locator(".receipt").filter(has_text=title)
    expect(card.get_by_role("button", name="通过验收")).to_be_visible(timeout=30000)
    expect(card.locator("code")).to_have_text(re.compile(r"T-\d{6}"))
    card.get_by_role("button", name="展开详情").click()
    drawer = page.get_by_role("complementary", name="工单详情")
    expect(drawer.get_by_text("本地确定性演示执行器已运行到对应分支", exact=True)).to_be_visible()
    expect(drawer.locator(".log").first).to_be_visible()
    drawer.get_by_role("button", name="开始校验").click()
    expect(drawer.get_by_text("fixture verification", exact=False)).to_be_visible()
    drawer.get_by_role("button", name="关闭详情").click()

    sidebar.get_by_role("button", name="搜索事项").click()
    sidebar.get_by_role("searchbox").fill(title)
    sidebar.get_by_role("button", name=re.compile(title)).click()
    expect(page).to_have_url(url + "/#messages/" + topic)
    expect(page.get_by_text("Thread 直通 · 跳过路由")).to_be_visible()
    page.get_by_role("button", name="proof.png", exact=True).click()
    expect(page.locator(".mc-lightbox-image")).to_have_js_property("naturalWidth", 1)
    page.keyboard.press("Escape")
    continued = submit(page, "继续在原事项核对并直接完成", conversation=topic)
    assert continued["topic"] == topic, continued
    page.reload()
    expect(page.get_by_text("继续在原事项核对并直接完成", exact=True)).to_be_visible(timeout=15000)

    approval = submit(page, "需要本人决定是否继续", project="content")
    intake = submit(page, "无法唯一判断归属的请求")
    assert intake["kind"] == "intake", intake
    page.goto(url + "/#inbox")
    expect(page.get_by_role("heading", name="待我处理", exact=True)).to_be_visible()
    expect(page.get_by_role("region", name="待澄清与失败请求").get_by_text("无法唯一判断归属的请求")).to_be_visible()
    approval_card = page.locator(".queue-card").filter(has_text="继续执行演示验证吗？")
    expect(approval_card.get_by_text("来自 主私聊")).to_be_visible(timeout=30000)
    approval_card.get_by_text("结束演示", exact=True).click()
    approval_card.get_by_role("button", name="提交答复").click()
    expect(approval_card).to_have_count(0)
    assert approval["topic"] != topic
    review = page.get_by_role("region", name="待验收").locator(".receipt").filter(has_text=title)
    expect(review.get_by_role("button", name="通过验收")).to_be_enabled(timeout=30000)
    review.get_by_role("button", name="通过验收").click()
    expect(review).to_have_count(0)
    unresolved = page.get_by_role("region", name="待澄清与失败请求")
    expect(unresolved.get_by_text("应用内不再接收新消息", exact=False)).to_be_visible()
    unresolved.get_by_role("button", name="忽略").click()
    expect(page.get_by_text("无法唯一判断归属的请求")).to_be_hidden()

    page.goto(url + "/#messages")
    plan_one = submit(page, "/plan 跨项目先核对订单，然后整理内容")
    assert plan_one["kind"] == "plan", plan_one
    page.reload()
    plan = page.locator(".plan").filter(has_text="跨项目交接").last
    expect(plan.get_by_text("依赖步骤 1", exact=False)).to_be_visible(timeout=20000)
    plan.get_by_role("button", name="取消草案").click()
    expect(plan.get_by_text("已取消", exact=True)).to_be_visible()
    plan_two = submit(page, "/plan 第二份跨项目交接")
    assert plan_two["kind"] == "plan", plan_two
    page.reload()
    start = page.get_by_role("button", name="确认启动计划")
    expect(start).to_be_enabled(timeout=20000)
    start.click()
    expect(page.locator(".plan").filter(has_text="进行中").get_by_text("进行中", exact=True)).to_be_visible()

    page.set_viewport_size({"width": 390, "height": 680})
    expect(page.locator(".mc-stage .view-header")).to_be_in_viewport()
    page.get_by_role("button", name="打开对话列表").click()
    expect(sidebar).to_be_visible()
    sidebar.get_by_role("button", name=re.compile("待我处理")).click()
    expect(page.get_by_role("heading", name="待我处理", exact=True)).to_be_visible()
    assert page.evaluate("""async () => {
      const deadline = Date.now() + 45000;
      while (Date.now() < deadline) {
        const {plans} = await (await fetch('/api/chief/plans')).json();
        if (plans.some(plan => plan.status === 'completed' && plan.steps.every(step => step.status === 'done'))) return true;
        await new Promise(resolve => setTimeout(resolve, 300));
      }
      return false;
    }""")
    assert not errors, errors
    browser.close()

print("Edge: read-only record, Thread, Inbox, attachments, acceptance and DAG actions passed")
