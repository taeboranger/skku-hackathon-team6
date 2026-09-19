import {
  cp,
  mkdir,
  mkdtemp,
  rm,
  writeFile,
  readdir,
  readlink,
  unlink,
  symlink,
} from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { resolve, dirname, relative, isAbsolute } from "node:path";
import { tmpdir } from "node:os";

const output = resolve(".vercel/output");
const functionDir = resolve(output, "functions/server.func");
await rm(output, { recursive: true, force: true });
await mkdir(resolve(output, "functions"), { recursive: true });
const staging = await mkdtemp(resolve(tmpdir(), "skku-app-bundle-"));
try {
  const deployed = resolve(staging, "server");
  execFileSync(
    process.platform === "win32" ? process.execPath : "corepack",
    [
      ...(process.platform === "win32"
        ? [
            resolve(
              dirname(process.execPath),
              "node_modules/corepack/dist/corepack.js",
            ),
          ]
        : []),
      "pnpm",
      "--filter",
      "@tutorial/server",
      "deploy",
      "--prod",
      deployed,
    ],
    { stdio: "inherit" },
  );
  await cp(deployed, functionDir, { recursive: true, verbatimSymlinks: true });
  // pnpm uses absolute junctions on Windows. Rebase them before removing staging.
  if (process.platform === "win32") {
    async function rebase(dir) {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const path = resolve(dir, entry.name);
        if (entry.isSymbolicLink()) {
          const target = await readlink(path),
            suffix = isAbsolute(target) ? relative(deployed,target) : relative(functionDir,resolve(dirname(path),target));
          if (suffix.startsWith("..") || isAbsolute(suffix))
            throw new Error(
              "Dependency link escapes the deployment staging directory",
            );
          await unlink(path);
          await symlink(resolve(functionDir, suffix), path, "junction");
        } else if (entry.isDirectory()) await rebase(path);
      }
    }
    await rebase(functionDir);
  }
} finally {
  await rm(staging, { recursive: true, force: true });
}
await writeFile(
  resolve(functionDir, "index.mjs"),
  'export { default } from "./dist/src/serverless.js";\n',
);
await writeFile(
  resolve(functionDir, ".vc-config.json"),
  JSON.stringify(
    { runtime: "nodejs24.x", handler: "index.mjs", launcherType: "Nodejs" },
    null,
    2,
  ),
);
await mkdir(resolve(output, "static/resource/wam/tutorial"), {
  recursive: true,
});
await cp("wam/dist", resolve(output, "static/resource/wam/tutorial"), {
  recursive: true,
});
await writeFile(
  resolve(output, "config.json"),
  JSON.stringify(
    {
      version: 3,
      routes: [
        {
          src: "^/resource/wam/tutorial$",
          status: 308,
          headers: { Location: "/resource/wam/tutorial/" },
        },
        {
          src: "^/resource/wam/tutorial/$",
          dest: "/resource/wam/tutorial/index.html",
        },
        { handle: "filesystem" },
        { src: "^/functions(?:/.*)?$", dest: "/server" },
        { src: "^/api/health$", dest: "/server" },
      ],
    },
    null,
    2,
  ),
);
console.log("Vercel Build Output ready: .vercel/output");
