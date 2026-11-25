// Prevent updates from changing a development checkout or losing the last runnable version on failed startup.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { VersionManager } from "../versions.mjs";

test("real Git releases install beside the checkout, activate, confirm, rollback and recover a failed boot", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "studio-versions-"));
  const repo = path.join(temp, "source"),
    store = path.join(temp, "versions");
  const git = (...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", windowsHide: true });
  try {
    await mkdir(path.join(repo, "client"), { recursive: true });
    git("init");
    git("config", "user.email", "test@example.invalid");
    git("config", "user.name", "Version test");
    await writeFile(
      path.join(repo, "client/package.json"),
      JSON.stringify({
        name: "version-fixture",
        private: true,
        type: "module",
        scripts: { build: "node --check server.mjs", check: "node --check server.mjs" },
      }),
    );
    await writeFile(
      path.join(repo, "client/package-lock.json"),
      JSON.stringify({ name: "version-fixture", lockfileVersion: 3, packages: { "": { name: "version-fixture" } } }),
    );
    await writeFile(path.join(repo, "client/desktop.cjs"), "// Desktop fixture\n");
    await writeFile(path.join(repo, "client/desktop-launch.mjs"), "// Launcher fixture\n");
    const server = `import {createServer} from 'node:http'; const server=createServer((q,r)=>r.end(q.url==='/api/state'?JSON.stringify({connected:true}):'release-one')); server.listen(0,'127.0.0.1',()=>console.log(JSON.stringify({ready:true,url:'http://127.0.0.1:'+server.address().port}))); process.on('message',m=>{if(m==='shutdown')server.close(()=>process.exit(0))});`;
    await writeFile(path.join(repo, "client/server.mjs"), server);
    git("add", ".");
    git("commit", "-m", "第一版：初始工作台");
    git("tag", "v1.0.0");
    await writeFile(path.join(repo, "client/server.mjs"), server.replace("release-one", "release-two"));
    git("add", ".");
    git("commit", "-m", "第二版：清透薄荷与真实更新");
    git("tag", "v1.1.0");
    git("checkout", "--detach", "v1.0.0");
    await writeFile(path.join(repo, "local-work.txt"), "不能覆盖的本地修改");
    const manager = new VersionManager({ root: repo, store, source: repo });
    assert.equal((await manager.info()).current.dirty, true);
    const checked = await manager.check();
    assert.equal(checked.available[0].tag, "v1.1.0");
    assert.match(checked.available[0].notes, /清透薄荷/);
    const installed = await manager.install(checked.available[0].id);
    assert.notEqual(installed.root, repo);
    assert.match(await readFile(path.join(installed.root, "client/server.mjs"), "utf8"), /release-two/);
    await manager.activate(installed.id);
    assert.equal((await manager.boot()).root, installed.root);
    await manager.confirm(installed.root);
    const newer = new VersionManager({ root: installed.root, store });
    assert.equal((await newer.info()).current.tag, "v1.1.0");
    const previous = (await newer.info()).history.find((v) => v.root === repo);
    await newer.activate(previous.id);
    assert.equal((await newer.boot()).root, repo);
    await newer.confirm(repo);
    assert.equal(await readFile(path.join(repo, "local-work.txt"), "utf8"), "不能覆盖的本地修改");
    await manager.activate(installed.id);
    assert.equal((await manager.boot()).root, installed.root);
    // A launch that never confirms must return to the previous installation on the next boot.
    assert.equal((await manager.boot()).root, repo);
    assert.match((await manager.info()).notice, /恢复/);
    await assert.rejects(manager.install("not-from-the-catalog"), /检查更新/);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
