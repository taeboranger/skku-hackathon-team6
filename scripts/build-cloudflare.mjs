import { cp, mkdir, rm } from "node:fs/promises";
try {
  await rm("cloudflare/static", { recursive: true, force: true });
} catch {}
await mkdir("cloudflare/static/resource/wam/tutorial", { recursive: true });
await cp("wam/dist", "cloudflare/static/resource/wam/tutorial", {
  recursive: true,
});

await cp("web/dist", "cloudflare/static", { recursive: true });
