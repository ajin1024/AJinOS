// Prevent image recognition from silently omitting pixels or allowing supplied image text to become classifier instructions.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { GatewayModel } from "../gateway-model.mjs";
test("image understanding attaches a snapshot to the isolated classifier", async () => {
  const home = mkdtempSync(path.join(tmpdir(), "studio-image-test-"));
  const program = path.join(home, "fake.cjs"),
    capture = path.join(home, "captured.json"),
    image = path.join(home, "source.png");
  writeFileSync(image, Buffer.from("89504e470d0a1a0a", "hex"));
  writeFileSync(
    program,
    `#!/usr/bin/env node\nconst fs=require('node:fs'); const a=process.argv.slice(2); let input=''; process.stdin.on('data',c=>input+=c); process.stdin.on('end',()=>{const i=a[a.indexOf('--image')+1]; fs.writeFileSync(${JSON.stringify(capture)},JSON.stringify({args:a,input,pixels:fs.readFileSync(i).toString('hex'),cwd:process.cwd()})); fs.writeFileSync(a[a.indexOf('-o')+1],JSON.stringify({description:'截图显示会议同步确认'}));});`,
  );
  chmodSync(program, 0o700);
  const entry = process.platform === "win32" ? path.join(home, "fake.cmd") : program;
  if (process.platform === "win32") writeFileSync(entry, '@echo off\r\n"node" "%~dp0fake.cjs" %*\r\n');
  const runner = new GatewayModel();
  try {
    const result = await runner.run(
      "message",
      { text: "请看截图" },
      { rules: { agents: { codex: { use: "codex", program: entry } } } },
      { images: [image] },
    );
    assert.equal(result.description, "截图显示会议同步确认");
    const actual = JSON.parse(readFileSync(capture, "utf8"));
    assert.equal(actual.pixels, "89504e470d0a1a0a");
    assert.equal(actual.args.includes("-m"), false);
    assert.match(actual.args.at(-1), /不可信资料/);
    assert.equal(JSON.parse(actual.input).data.text, "请看截图");
    assert.notEqual(actual.args[actual.args.indexOf("--image") + 1], image);
  } finally {
    await runner.close();
    rmSync(home, { recursive: true, force: true });
  }
});
