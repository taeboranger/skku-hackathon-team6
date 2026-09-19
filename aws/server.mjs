// AWS entrypoint — the Node counterpart of cloudflare/worker.mjs.
//
// Workers gives the app three things this file has to reproduce on a plain
// Node host: a D1 binding, static asset serving ahead of the worker, and a
// cron trigger. The app's SQL is SQLite-specific (INSERT OR IGNORE, json_valid,
// backtick identifiers), so the database stays SQLite — node:sqlite over a file
// on the instance volume — behind the same D1-shaped interface the app already
// codes against.
import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import {
  createReadStream,
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { withDatabase } from "../server/dist/src/database.js";
import nestHandler from "../server/dist/src/serverless.js";
import { withCampus } from "../server/dist/src/campus/server.js";
import { GET, POST } from "../server/dist/src/campus/routes.js";
import { expire } from "../server/dist/src/campus/service.js";
import { deliverPush } from "../server/dist/src/campus/push.js";
import { deliverChannelReplies } from "../server/dist/src/campus/channel.js";

const here = fileURLToPath(new URL(".", import.meta.url));
const STATIC_DIR = resolve(here, "../cloudflare/static");
const MIGRATIONS_DIR = resolve(here, "../cloudflare/migrations");
const DB_PATH = process.env.DB_PATH ?? "/var/lib/campus/app.sqlite";
const PORT = Number(process.env.PORT ?? 8080);
const CRON_INTERVAL_MS = Number(process.env.CRON_INTERVAL_MS ?? 60_000);

/* ── D1-compatible adapter over node:sqlite ──────────────────────────── */

const sqlite = new DatabaseSync(DB_PATH);
sqlite.exec("PRAGMA journal_mode = WAL");
sqlite.exec("PRAGMA busy_timeout = 5000");
sqlite.exec("PRAGMA foreign_keys = ON");

// node:sqlite only binds null/number/bigint/string/Uint8Array. D1 tolerates
// booleans and undefined, which the app does pass, so normalize them here.
const coerce = (value) => {
  if (value === undefined) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  return value;
};

function prepare(sql) {
  const make = (args) => ({
    sql,
    args,
    bind: (...next) => make(next.map(coerce)),
    async first(column) {
      const found = sqlite.prepare(sql).get(...args) ?? null;
      if (found && column !== undefined) return found[column] ?? null;
      return found;
    },
    async all() {
      const results = sqlite.prepare(sql).all(...args);
      return { results, success: true, meta: {} };
    },
    async run() {
      const r = sqlite.prepare(sql).run(...args);
      return {
        success: true,
        meta: {
          changes: Number(r.changes ?? 0),
          last_row_id: Number(r.lastInsertRowid ?? 0),
        },
      };
    },
    raw: async () =>
      sqlite
        .prepare(sql)
        .all(...args)
        .map((row) => Object.values(row)),
  });
  return make([]);
}

// D1 runs a batch as one implicit transaction; mirror that so the app's
// rollback-on-failure paths (question fanout, point ledger) behave the same.
const DB = {
  prepare,
  async batch(statements) {
    sqlite.exec("BEGIN");
    try {
      const out = [];
      for (const statement of statements) out.push(await statement.run());
      sqlite.exec("COMMIT");
      return out;
    } catch (error) {
      sqlite.exec("ROLLBACK");
      throw error;
    }
  },
  async exec(sql) {
    sqlite.exec(sql);
    return { count: 0, duration: 0 };
  },
  dump: async () => {
    throw new Error("dump is not supported on the AWS runtime");
  },
  withSession: () => DB,
};

/* ── Migrations ──────────────────────────────────────────────────────── */

// D1 tracks applied migrations itself; on AWS we keep the same ledger so the
// non-idempotent CREATE TABLE statements in cloudflare/migrations run once.
function migrate() {
  sqlite.exec(
    "CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)",
  );
  const applied = new Set(
    sqlite
      .prepare("SELECT name FROM d1_migrations")
      .all()
      .map((r) => r.name),
  );
  const pending = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .filter((f) => !applied.has(f));
  for (const name of pending) {
    const sql = readFileSync(join(MIGRATIONS_DIR, name), "utf8");
    sqlite.exec("BEGIN");
    try {
      sqlite.exec(sql);
      sqlite.prepare("INSERT INTO d1_migrations (name) VALUES (?)").run(name);
      sqlite.exec("COMMIT");
      console.log(`[migrate] applied ${name}`);
    } catch (error) {
      sqlite.exec("ROLLBACK");
      throw new Error(`migration ${name} failed: ${error.message}`);
    }
  }
  if (!pending.length) console.log("[migrate] up to date");
}

/* ── Static assets ───────────────────────────────────────────────────── */

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json; charset=utf-8",
};

function resolveAsset(pathname) {
  // normalize() plus the prefix check keeps ../ traversal out of STATIC_DIR.
  const target = normalize(join(STATIC_DIR, decodeURIComponent(pathname)));
  if (!target.startsWith(STATIC_DIR)) return null;
  const candidates = [target];
  if (pathname.endsWith("/")) candidates.push(join(target, "index.html"));
  for (const candidate of candidates) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

function sendAsset(file, response) {
  const type = MIME[extname(file).toLowerCase()] ?? "application/octet-stream";
  const immutable = file.includes(`${"/"}assets${"/"}`);
  response.writeHead(200, {
    "Content-Type": type,
    "Cache-Control": immutable
      ? "public, max-age=31536000, immutable"
      : "no-cache",
    "X-Content-Type-Options": "nosniff",
  });
  createReadStream(file).pipe(response);
}

/* ── Request/Response bridging for the campus routes ─────────────────── */

function toWebRequest(req, origin) {
  const url = new URL(req.url, origin);
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (Array.isArray(v)) v.forEach((one) => headers.append(k, one));
    else if (v !== undefined) headers.set(k, v);
  }
  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  return new Request(url, {
    method: req.method,
    headers,
    body: hasBody ? req : undefined,
    duplex: hasBody ? "half" : undefined,
  });
}

async function sendWebResponse(webResponse, res) {
  const headers = {};
  for (const [k, v] of webResponse.headers) headers[k] = v;
  res.writeHead(webResponse.status, headers);
  if (webResponse.body) {
    const buffer = Buffer.from(await webResponse.arrayBuffer());
    res.end(buffer);
  } else res.end();
}

/* ── Scheduled work (the Workers cron trigger) ───────────────────────── */

let cronRunning = false;
async function runScheduled() {
  if (cronRunning) return;
  cronRunning = true;
  try {
    await withCampus({ DB }, undefined, async () => {
      await expire();
      await deliverPush();
      await deliverChannelReplies();
    });
  } catch (error) {
    console.error("[cron] failed:", error?.message ?? error);
  } finally {
    cronRunning = false;
  }
}

/* ── Server ──────────────────────────────────────────────────────────── */

const bindings = { DB };

const server = createServer((req, res) => {
  const origin = process.env.APP_ORIGIN || `http://localhost:${PORT}`;
  const pathname = new URL(req.url, origin).pathname;

  const dispatch = async () => {
    if (pathname === "/api/ready" && req.method === "GET") {
      try {
        await DB.prepare("SELECT 1 AS ok").first();
        return sendWebResponse(Response.json({ ok: true }), res);
      } catch {
        return sendWebResponse(
          Response.json({ ok: false }, { status: 503 }),
          res,
        );
      }
    }

    // Mirrors wrangler.jsonc run_worker_first: /functions* and /api/* never
    // fall through to static assets.
    const workerFirst =
      pathname === "/functions" ||
      pathname.startsWith("/functions/") ||
      pathname.startsWith("/api/");

    if (
      pathname.startsWith("/api/") &&
      !["/api/health", "/api/ready"].includes(pathname)
    ) {
      const request = toWebRequest(req, origin);
      const response = await withCampus(bindings, request, () =>
        req.method === "GET"
          ? GET(request)
          : req.method === "POST"
            ? POST(request)
            : Response.json({ error: "Method not allowed" }, { status: 405 }),
      );
      response.headers.set("Cache-Control", "no-store");
      response.headers.set("X-Content-Type-Options", "nosniff");
      if (pathname === "/api/channel/webhook" && response.ok) {
        void withCampus(bindings, undefined, async () => {
          await deliverChannelReplies();
          await deliverPush();
        }).catch((e) =>
          console.error("[webhook] follow-up failed:", e?.message ?? e),
        );
      }
      return sendWebResponse(response, res);
    }

    if (!workerFirst) {
      const file = resolveAsset(pathname);
      if (file) return sendAsset(file, res);
      // SPA fallback for client-side routes.
      if (!extname(pathname)) {
        const index = join(STATIC_DIR, "index.html");
        if (existsSync(index)) return sendAsset(index, res);
      }
    }

    return withCampus(bindings, undefined, () =>
      withDatabase(DB, () => nestHandler(req, res)),
    );
  };

  void dispatch().catch((error) => {
    console.error(
      "Request failed",
      error instanceof Error ? error.message : "unknown",
    );
    if (!res.headersSent)
      res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "internal error" }));
  });
});

migrate();
server.listen(PORT, () => {
  console.log(`[server] listening on :${PORT}`);
  console.log(`[server] sqlite at ${DB_PATH}`);
  console.log(`[server] static from ${STATIC_DIR}`);
});

setInterval(runScheduled, CRON_INTERVAL_MS).unref();

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    server.close(() => {
      try {
        sqlite.close();
      } catch {}
      process.exit(0);
    });
  });
}
