# Prevent measured SVG wires from crossing cards after a viewport resize or a task drawer opens.
from contextlib import nullcontext
import sys

from playwright.sync_api import expect, sync_playwright
from studio_browser import running_studio, submit, wait_online


target = sys.argv[1] if len(sys.argv) > 1 else None
with (nullcontext(target) if target else running_studio("studio-flow-geometry-")) as url, sync_playwright() as playwright:
    browser = playwright.chromium.launch(channel="msedge", headless=True)
    page = browser.new_page(base_url=url, viewport={"width": 1440, "height": 900}, reduced_motion="reduce")
    page.goto(url.split("#", 1)[0] + "#overview")
    wait_online(page)
    if not target:
        submit(page, "核对画布连接并直接完成", project="orders")
    flow = page.get_by_role("region", name="任务处理流程图")
    inspectable = flow.locator(".ticket-row").first
    expect(inspectable).to_be_visible(timeout=30000)
    inspectable.click()
    expect(page.get_by_role("complementary", name="工单详情")).to_be_visible()
    for width, height in ((1440, 900), (1280, 720)):
        page.set_viewport_size({"width": width, "height": height})
        expect(flow.locator(".wire-group.hot").first).to_be_visible()
        page.wait_for_function("""() => {
          const field = document.querySelector('.super-agent-flow .flow-body');
          const paths = [...field.querySelectorAll('.wire-group path')];
          if (!paths.length) return false;
          const frame = field.getBoundingClientRect();
          const cards = [...field.querySelectorAll('.card[data-node]')].map(card => card.getBoundingClientRect());
          return paths.every(path => {
            const length = path.getTotalLength();
            for (let offset = 0; offset < length; offset += 2) {
              const point = path.getPointAtLength(offset);
              const x = frame.left + point.x, y = frame.top + point.y;
              if (cards.some(card => x > card.left + 1 && x < card.right - 1 && y > card.top + 1 && y < card.bottom - 1))
                return false;
            }
            return true;
          });
        }""")
    browser.close()

print("Edge: tracked wires clear every card at 1440x900 and 1280x720")
