# Prevent the private chat, Inbox, Thread continuation, attachments and plan actions from losing their real backend bindings.
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
    expect(page.get_by_role("heading", name="任务处理流程")).to_be_visible()
    page.get_by_role("navigation", name="主导航").get_by_role("button", name="对话").click()
    expect(page.get_by_role("heading", name="AJinOS 总管", exact=True)).to_be_visible()
    sidebar = page.get_by_role("complementary", name="对话列表")
    composer = page.locator(".composer")
    field = composer.get_by_role("textbox", name="任务说明")
    send = composer.get_by_role("button", name="发送", exact=True)
    expect(composer.get_by_label("执行器 / 模型")).to_have_count(0)

    before = state(page)["state"].get("tickets", [])
    field.fill("今日简报")
    field.press("Enter")
    expect(page.get_by_text("只读简报 · 未开单", exact=True)).to_be_visible()
    assert before == state(page)["state"].get("tickets", [])
    page.reload()
    expect(page.get_by_text("只读简报 · 未开单", exact=True)).to_be_visible()

    field.fill("先别开工，聊聊怎么优化订单核对")
    field.press("Enter")
    expect(page.get_by_text("需求沟通 · 未开单", exact=True)).to_be_visible()
    assert before == state(page)["state"].get("tickets", [])
    expect(page.get_by_role("button", name="按此派发任务")).to_be_visible()
    composer.get_by_role("button", name="结束需求沟通").click()

    composer.get_by_role("button", name="指定选项").click()
    composer.get_by_label("项目", exact=True).select_option("orders")
    composer.locator('input[type="file"]').set_input_files({"name": "proof.png", "mimeType": "image/png", "buffer": PNG})
    field.evaluate("""(input, bytes) => {
      const clipboardData = new DataTransfer();
      clipboardData.items.add(new File([new Uint8Array(bytes)], "pasted.png", {type:"image/png"}));
      input.dispatchEvent(new ClipboardEvent("paste", {clipboardData, bubbles:true, cancelable:true}));
    }""", list(PNG))
    expect(composer.locator(".attachments img")).to_have_count(2)
    title = "核对订单并直接完成"
    field.fill(title)
    field.press("Shift+Enter")
    expect(field).to_have_value(title + "\n")

    pending = []

    def hold(route):
        pending.append(route)

    page.route("**/api/router/message", hold)
    send.click()
    expect(field).to_be_editable()
    expect(field).to_have_value("")
    expect(composer.locator(".attachments img")).to_have_count(0)
    exchange = page.locator(".exchange").filter(has_text=title).last
    expect(exchange.locator(".user-message .attachments img")).to_have_count(2)
    expect(exchange.get_by_role("status")).to_contain_text("正在发送")
    field.press("Enter")
    assert len(pending) == 1
    failed = pending.pop()
    failed_id = failed.request.post_data_json["id"]
    failed.fulfill(status=503, json={"error": "测试连接暂时中断"})
    expect(exchange.get_by_role("alert")).to_contain_text("测试连接暂时中断")
    expect(exchange.locator(".user-message .attachments img")).to_have_count(2)
    page.unroute("**/api/router/message", hold)

    with page.expect_response(lambda response: response.url.endswith("/api/router/message") and response.request.method == "POST") as sent:
        exchange.get_by_role("button", name="重试").click()
    assert failed_id == sent.value.request.post_data_json["id"]
    receipt = sent.value.json()
    assert receipt["kind"] == "task" and receipt["project"] == "orders", receipt
    expect(page).to_have_url(url + "/#messages")
    topic = receipt["topic"]
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
    field.fill("继续在原事项核对并直接完成")
    with page.expect_response(lambda response: response.url.endswith("/api/router/message") and response.request.method == "POST") as continued:
        field.press("Enter")
    assert continued.value.json()["topic"] == topic
    assert continued.value.request.post_data_json["conversation"] == topic
    expect(page.get_by_text("继续在原事项核对并直接完成", exact=True)).to_be_visible(timeout=12000)

    field.fill("保存在原事项的草稿")
    sidebar.get_by_role("button", name=re.compile("AJinOS 总管")).click()
    expect(sidebar.get_by_role("button", name=re.compile(title)).get_by_text("草稿")).to_be_visible()
    sidebar.get_by_role("button", name=re.compile(title)).click()
    expect(field).to_have_value("保存在原事项的草稿")
    field.fill("")

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
    unresolved.get_by_role("button", name="订单服务 · 演示").click()
    unresolved.get_by_role("button", name="用这个项目重新提交").click()
    expect(page.get_by_text("Thread 直通 · 跳过路由")).to_be_visible()

    sidebar.get_by_role("button", name=re.compile("AJinOS 总管")).click()
    field.fill("/plan 跨项目先核对订单，然后整理内容")
    send.click()
    plan = page.locator(".plan").filter(has_text="跨项目交接").last
    expect(plan.get_by_text("依赖步骤 1", exact=False)).to_be_visible(timeout=20000)
    plan.get_by_role("button", name="取消草案").click()
    expect(plan.get_by_text("已取消", exact=True)).to_be_visible()
    field.fill("/plan 第二份跨项目交接")
    send.click()
    start = page.get_by_role("button", name="确认启动计划")
    expect(start).to_be_enabled(timeout=20000)
    start.click()
    expect(page.locator(".plan").filter(has_text="进行中").get_by_text("进行中", exact=True)).to_be_visible()

    page.set_viewport_size({"width": 390, "height": 680})
    expect(field).to_be_in_viewport()
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

print("Edge: private chat, Thread, Inbox, attachments, acceptance and DAG actions passed")
