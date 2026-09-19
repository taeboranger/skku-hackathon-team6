import { createServer } from "node:http";
import { httpServerHandler } from "cloudflare:node";
import { env } from "cloudflare:workers";
import { withDatabase } from "../server/dist/src/database.js";
import handler from "../server/dist/src/serverless.js";
import { withCampus } from "../server/dist/src/campus/server.js";
import { GET, POST } from "../server/dist/src/campus/routes.js";
import { expire } from "../server/dist/src/campus/service.js";
import { deliverPush } from "../server/dist/src/campus/push.js";
import { deliverChannelReplies } from "../server/dist/src/campus/channel.js";

const server = createServer((request, response) => {
  void withCampus(env, undefined, () =>
    withDatabase(env.DB, () => handler(request, response)),
  ).catch((error) => {
    console.error(
      "Request failed",
      error instanceof Error ? error.message : "unknown",
    );
    if (!response.headersSent) response.writeHead(500);
    response.end();
  });
});
const http = httpServerHandler(server);
export default {
  async fetch(request, bindings, context) {
    if (
      new URL(request.url).pathname === "/api/ready" &&
      request.method === "GET"
    ) {
      try {
        await bindings.DB.prepare("SELECT 1 AS ok").first();
        return Response.json({ ok: true });
      } catch {
        return Response.json({ ok: false }, { status: 503 });
      }
    }
    const path = new URL(request.url).pathname;
    if (
      path.startsWith("/api/") &&
      !["/api/health", "/api/ready"].includes(path)
    ) {
      const response = await withCampus(bindings, request, () =>
        request.method === "GET"
          ? GET(request)
          : request.method === "POST"
            ? POST(request)
            : Response.json({ error: "Method not allowed" }, { status: 405 }),
      );
      response.headers.set("Cache-Control", "no-store");
      response.headers.set("X-Content-Type-Options", "nosniff");
      if (path === "/api/channel/webhook" && response.ok)
        context.waitUntil(
          withCampus(bindings, undefined, async () => {
            await deliverChannelReplies();
            await deliverPush();
          }),
        );
      return response;
    }
    return withCampus(bindings, request, () =>
      http.fetch(request, bindings, context),
    );
  },
  async scheduled(_controller, bindings, context) {
    context.waitUntil(
      withCampus(bindings, undefined, async () => {
        await expire();
        await deliverPush();
        await deliverChannelReplies();
      }),
    );
  },
};
