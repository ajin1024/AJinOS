from contextlib import contextmanager
import json
import os
from pathlib import Path
from queue import Queue
import subprocess
from threading import Thread

from playwright.sync_api import expect
from studio_home import studio_home


ROOT = Path(__file__).resolve().parents[2]
SERVER = """
import { startDemoStudio } from './client/tests/studio-fixtures.mjs';
const studio = await startDemoStudio({
  home: process.argv[1], port: 0, autostart: true, businessTasks: true,
  gatewayModel: async (kind, input) => {
    if (kind === 'confirm') throw Error('router should not request model confirmation');
    if (kind === 'message') return { description: 'fixture image' };
    if (kind === 'verify') return { verdict: 'pass', summary: 'fixture verification', findings: [] };
    if (kind === 'plan') return { title: '跨项目交接', steps: [
      { id: 'orders', title: '核对订单', project: 'orders', instruction: '直接完成订单核对' },
      { id: 'content', title: '整理内容', project: 'content', dependsOn: ['orders'], instruction: '直接完成内容整理' }
    ] };
    if (input.text.includes('无法唯一判断')) return {
      certain: false, reason: '请指定所属项目', candidates: ['orders', 'content']
    };
    return { project: 'orders', flow: 'default', certain: true, reason: 'fixture routing' };
  },
});
console.log(JSON.stringify({url:studio.url}));
process.stdin.once('data', async () => { await studio.close(); process.exit(0); });
"""


@contextmanager
def running_studio(prefix):
    with studio_home(prefix) as home, (Path(home) / "studio.log").open("w+", encoding="utf-8") as log:
        process = subprocess.Popen(
            ["node", "--input-type=module", "-e", SERVER, home], cwd=ROOT,
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=log, text=True, encoding="utf-8",
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
        )
        ready = Queue()
        Thread(target=lambda: ready.put(process.stdout.readline()), daemon=True).start()
        try:
            line = ready.get(timeout=45)
            if not line:
                log.seek(0)
                raise RuntimeError(log.read())
            yield json.loads(line)["url"]
        finally:
            if process.poll() is None:
                process.communicate(input="stop\n", timeout=30)


def wait_online(page):
    expect(page.locator("#engine-power")).to_have_attribute("data-engine-state", "online", timeout=30000)


def submit(page, text, path="/api/router/message", **fields):
    response = page.request.post(path, headers={"x-studio-action": "1"}, data={"text": text, **fields})
    assert response.ok, response.text()
    return response.json()


def state(page):
    response = page.request.get("/api/state")
    assert response.ok, response.text()
    return response.json()
