import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { randomBytes } from "node:crypto";
const require = createRequire(
  new URL("../server/package.json", import.meta.url),
);
const { generateVAPIDKeys } = require("web-push");
const path = new URL("../.dev.vars", import.meta.url);
let text = await readFile(path, "utf8").catch(() => "");
const keys = generateVAPIDKeys();
const defaults = {
  APP_ID: "local-test-app",
  APP_SECRET: "local-test-secret",
  SIGNING_KEY: "11".repeat(32),
  APP_STORE_URL: "https://app-store-api.channel.io",
  APP_ORIGIN: "http://localhost:8787",
  LETSUR_API_KEY: "",
  LETSUR_BASE_URL: "https://gw.letsur.ai/v1",
  LETSUR_MODEL: "gpt-4.1-mini",
  CHANNEL_PLUGIN_KEY: "",
  CHANNEL_MEMBER_HASH_SECRET: "",
  CHANNEL_ACCESS_KEY: "",
  CHANNEL_ACCESS_SECRET: "",
  CHANNEL_WEBHOOK_TOKEN: randomBytes(32).toString("hex"),
  VAPID_PUBLIC_KEY: keys.publicKey,
  VAPID_PRIVATE_KEY: keys.privateKey,
  VAPID_SUBJECT: "mailto:campus@example.com",
  CRON_SECRET: randomBytes(32).toString("hex"),
};
for (const [key, value] of Object.entries(defaults))
  if (!new RegExp("^" + key + "=", "m").test(text))
    text += "\n" + key + "=" + value;
await writeFile(path, text.trim() + "\n");
console.log(
  ".dev.vars prepared. Existing values preserved; secret values are not printed.",
);
