import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
const origin = process.env.SMOKE_ORIGIN || "http://127.0.0.1:8787";
if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(origin))
  throw Error("Local test only");
async function call(method, params, caller = { type: "system" }) {
  const body = JSON.stringify({
    method,
    params,
    context: { channel: { id: "local-test" }, caller },
  });
  const signature = createHmac("sha256", Buffer.from("11".repeat(32), "hex"))
    .update(body)
    .digest("base64");
  const r = await fetch(origin + "/functions", {
    method: "PUT",
    headers: { "content-type": "application/json", "x-signature": signature },
    body,
  });
  assert.equal(r.status, 200);
  return r.json();
}
const realtime = await call("campus.searchAnswers", {
  query: "지금 학생회관에 자리 있나요?",
  realtime: false,
});
assert.deepEqual(realtime.result, { realtime: true, sources: [] });
const list = await call(
  "campus.listQuestions",
  {},
  { type: "manager", id: "local-manager" },
);
assert(Array.isArray(list.result.questions));
const denied = await call(
  "campus.listQuestions",
  {},
  { type: "user", id: "local-user" },
);
assert(denied.error);
const anonymous = await fetch(origin + "/api/questions", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: "{}",
});
assert.equal(anonymous.status, 401);
const state = await fetch(origin + "/api/state");
assert.equal(state.status, 200);
assert.equal(state.headers.get("cache-control"), "no-store");
assert.equal((await fetch(origin + "/")).status, 200);
console.log(
  "PASS: ALF search realtime bypass, manager WAM query, caller restrictions, API authentication, website",
);
