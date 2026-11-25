import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, cp, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { Arch, build, Platform } from "electron-builder";
import { versionOf } from "./versions.mjs";
import { repositoryName, setupName } from "./windows-updates.mjs";

if (process.platform !== "win32" || process.arch !== "x64" || process.versions.node.split(".")[0] !== "24")
  throw new Error("请使用 Windows x64 版 Node.js 24 构建安装包");

const client = import.meta.dirname;
const root = path.dirname(client);
const require = createRequire(import.meta.url);
const electronDist = path.dirname(require("electron"));
const electronVersion = require("electron/package.json").version;
const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== "--update-repo" || !repositoryName.test(args[1])))
  throw new Error("用法：npm run package:windows [-- --update-repo owner/repo]");
const updateRepo = args[1];
const artifactName = setupName;
const output = path.join(client, "dist", ...(updateRepo ? ["autoupdate"] : []));
const osTmp = path.resolve(tmpdir());
const stage = await mkdtemp(path.join(osTmp, "studio-installer-"));

try {
  execFileSync(process.execPath, [path.join(client, "build.mjs")], { stdio: "inherit" });
  const current = await versionOf(root);
  const version = !current.dirty && current.tag ? current.tag.slice(1) : "0.0.0";
  const app = path.join(stage, "app");
  const appClient = path.join(app, "client");
  await mkdir(appClient, { recursive: true });
  const modules = (await readdir(client)).filter(
    (name) => /\.(mjs|cjs)$/.test(name) && !["build.mjs", "package-windows.mjs", "desktop-launch.mjs"].includes(name),
  );
  await Promise.all([
    ...["bin", "cli", "host", "kernel", "plugins", "protocol", "worker"].map((name) =>
      cp(path.join(root, name), path.join(app, name), { recursive: true }),
    ),
    copyFile(path.join(root, "LICENSE"), path.join(app, "LICENSE")),
    ...modules.map((name) => copyFile(path.join(client, name), path.join(appClient, name))),
    cp(path.join(client, "assets"), path.join(appClient, "assets"), { recursive: true }),
    cp(path.join(client, "src"), path.join(appClient, "src"), { recursive: true }),
    cp(path.join(client, "public"), path.join(appClient, "public"), {
      recursive: true,
      filter: (source) => source !== path.join(client, "public", "art"),
    }),
    writeFile(
      path.join(app, "package.json"),
      JSON.stringify({
        name: "ajinos-studio",
        productName: "AJinOS",
        version,
        description: "AJinOS Studio — Local desktop workspace powered by Agent Autoloop",
        main: "client/desktop.cjs",
        type: "module",
        license: "MIT",
        ...(updateRepo && { studioUpdateRepo: updateRepo }),
      }),
    ),
  ]);

  const nodeDist = path.dirname(process.execPath);
  const node = path.join(stage, "node");
  await mkdir(node);
  await Promise.all([
    copyFile(process.execPath, path.join(node, "node.exe")),
    copyFile(path.join(nodeDist, "LICENSE"), path.join(node, "LICENSE")),
    ...(existsSync(path.join(nodeDist, "vcruntime140.dll"))
      ? [copyFile(path.join(nodeDist, "vcruntime140.dll"), path.join(node, "vcruntime140.dll"))]
      : []),
  ]);

  await build({
    projectDir: app,
    targets: Platform.WINDOWS.createTarget("nsis", Arch.x64),
    publish: "never",
    config: {
      appId: "com.ajinos.studio",
      artifactName,
      electronVersion,
      electronDist,
      // The bundled Node process loads the server, TypeScript and PowerShell scripts from disk.
      asar: false,
      directories: { output: path.join(stage, "output") },
      extraResources: [{ from: node, to: "node" }],
      win: { signExecutable: false, icon: path.join(client, "assets", "icon.ico") },
      nsis: {
        oneClick: true,
        perMachine: false,
        shortcutName: "AJinOS",
        installerIcon: path.join(client, "assets", "icon.ico"),
        uninstallerIcon: path.join(client, "assets", "icon.ico"),
      },
    },
  });
  await mkdir(output, { recursive: true });
  await copyFile(path.join(stage, "output", artifactName), path.join(output, artifactName));
  console.log(path.join(output, artifactName));
} finally {
  if (path.dirname(stage) === osTmp && path.basename(stage).startsWith("studio-installer-"))
    await rm(stage, { recursive: true, force: true, maxRetries: 4, retryDelay: 250 });
}
