import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { withCampus, row, db } from "./campus/server.js";
import { createQuestion, answerQuestion, expire } from "./campus/service.js";
import { GET, POST } from "./campus/routes.js";
import { rankCandidate, reach, haversineDistance, type Profile } from "./campus/domain.js";
import { channelWebhook, deliverChannelReplies } from "./campus/channel.js";
import { resolveLocationCoordinates, findSKKUPoiCoordinates } from "./campus/naver.js";

test("non-realtime questions reuse stored human answers with valid source IDs", async (t) => {
  const f = fixture();
  t.after(() => f.sqlite.close());
  t.mock.method(globalThis, "fetch", async (_url: any, options: any) => {
    const payload = JSON.parse(options.body),
      sourceInput = JSON.parse(payload.input);
    const value =
      payload.text.format.name === "grounded_answer"
        ? {
            supported: true,
            answer: "학과 사무실에 신청하세요.",
            sourceIds: [sourceInput.sources[0].id],
          }
        : {
            realtime: false,
            answerType: "text",
            department: "컴퓨터공학과",
            location: "",
            tags: ["복수전공"],
          };
    return Response.json({
      output: [
        { content: [{ type: "output_text", text: JSON.stringify(value) }] },
      ],
    });
  });
  const author = await f.person("author"),
    helper = await f.person("helper");
  await f.run(async () => {
    const question = {
      ...input,
      title: "복수전공 신청 방법 알려주세요",
      body: "컴퓨터공학과 복수전공 신청 방법이 궁금해요.",
      realtime: false,
      location: "",
    };
    const first = await createQuestion(author, question);
    await answerQuestion(helper, {
      questionId: first.question.id,
      body: "학과 사무실에 신청하세요.",
    });
    const second = await createQuestion(author, {
      ...question,
      requestId: "another-request",
    });
    assert.equal(second.question.aiAnswer, "학과 사무실에 신청하세요.");
    assert.deepEqual(second.question.sources, [first.question.id]);
    assert.equal(
      (
        await row(
          "SELECT COUNT(*) n FROM requests WHERE question_id=?",
          second.question.id,
        )
      ).n,
      0,
    );
  });
});

function fixture() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(
    readFileSync(
      new URL("../../cloudflare/migrations/0002_campus.sql", import.meta.url),
      "utf8",
    ),
  );
  function prepare(sql: string) {
    const statement = {
      args: [] as any[],
      bind(...args: any[]) {
        this.args = args;
        return this;
      },
      async first() {
        return sqlite.prepare(sql).get(...this.args) || null;
      },
      async all() {
        return { results: sqlite.prepare(sql).all(...this.args) };
      },
      async run() {
        const result = sqlite.prepare(sql).run(...this.args);
        return { meta: { changes: Number(result.changes) } };
      },
    };
    return statement;
  }
  const binding = {
    prepare,
    async batch(statements: ReturnType<typeof prepare>[]) {
      sqlite.exec("BEGIN");
      try {
        const result = [];
        for (const stmt of statements) result.push(await stmt.run());
        sqlite.exec("COMMIT");
        return result;
      } catch (e) {
        sqlite.exec("ROLLBACK");
        throw e;
      }
    },
  };
  const bindings = {
    DB: binding as any,
    OPENAI_API_KEY: "test-only",
    CHANNEL_WEBHOOK_TOKEN: "test-hook",
    CHANNEL_ACCESS_KEY: "test-key",
    CHANNEL_ACCESS_SECRET: "test-secret",
  };
  const run = <T>(fn: () => T, request?: Request) =>
    withCampus(bindings, request, fn);
  async function person(
    id: string,
    role: "freshman" | "senior" = "freshman",
  ): Promise<Profile> {
    await run(async () => {
      await db()
        .prepare(
          `INSERT INTO profiles(id,auth_id,name,role,department,student_id,points,location,location_at,created_at) VALUES(?,?,?,?,?,?,100,'학생회관',?,?)`,
        )
        .bind(id, id, id, role, "컴퓨터공학과", id, Date.now(), Date.now())
        .run();
      await db()
        .prepare(`INSERT INTO ledger VALUES(?,?,100,'가입',?)`)
        .bind("signup:" + id, id, Date.now())
        .run();
    });
    return run(() => row("SELECT * FROM profiles WHERE id=?", id));
  }
  return { run, person, sqlite };
}
const input = {
  title: "지금 학생회관에 자리 있나요?",
  body: "식당 좌석이 궁금합니다.",
  department: "컴퓨터공학과",
  location: "학생회관",
  targetHint: "",
  realtime: true,
  requestId: "unique-request-1",
};
function mockAI(t: any) {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    return Response.json({
      output: [
        {
          content: [
            {
              type: "output_text",
              text: JSON.stringify({
                realtime: false,
                answerType: "yes_no",
                department: "컴퓨터공학과",
                location: "학생회관",
                tags: ["식당"],
              }),
            },
          ],
        },
      ],
    });
  });
  return () => calls;
}

test("realtime questions bypass historical AI answers; duplicate creation has one fanout", async (t) => {
  const f = fixture();
  t.after(() => f.sqlite.close());
  const calls = mockAI(t);
  const author = await f.person("author");
  await f.person("helper");
  await f.run(async () => {
    const first = await createQuestion(author, input);
    const retry = await createQuestion(author, input);
    assert.equal(first.question.realtime, 1);
    assert.equal(first.question.aiAnswer, null);
    assert.equal(first.question.id, retry.question.id);
    assert.equal((await row("SELECT COUNT(*) n FROM requests")).n, 1);
    assert.equal(calls(), 1);
  });
});
test("seniors cannot ask and duplicate answers award points once", async (t) => {
  const f = fixture();
  t.after(() => f.sqlite.close());
  mockAI(t);
  const author = await f.person("author"),
    senior = await f.person("senior", "senior");
  await f.run(async () => {
    await assert.rejects(() => createQuestion(senior, input), /선배/);
    const { question } = await createQuestion(author, input);
    await answerQuestion(senior, { questionId: question.id, body: "네" });
    await answerQuestion(senior, { questionId: question.id, body: "네" });
    assert.equal(
      (await row("SELECT points FROM profiles WHERE id=?", senior.id)).points,
      110,
    );
    assert.equal((await row("SELECT COUNT(*) n FROM answers")).n, 1);
    await answerQuestion(author, { questionId: question.id, body: "고마워요" });
    assert.equal(
      (await row("SELECT points FROM profiles WHERE id=?", author.id)).points,
      100,
    );
  });
});
test("only acknowledged unanswered freshman requests lose points; expiry is idempotent", async (t) => {
  const f = fixture();
  t.after(() => f.sqlite.close());
  mockAI(t);
  const author = await f.person("author");
  for (const [id, role] of [
    ["seen", "freshman"],
    ["unseen", "freshman"],
    ["senior", "senior"],
  ] as const)
    await f.person(id, role);
  await f.run(async () => {
    await createQuestion(author, input);
    await db()
      .prepare(
        "UPDATE requests SET expires_at=0,seen_at=CASE WHEN user_id='unseen' THEN NULL ELSE 1 END",
      )
      .run();
    await expire();
    await expire();
    assert.equal(
      (await row("SELECT points FROM profiles WHERE id='seen'")).points,
      97,
    );
    assert.equal(
      (await row("SELECT points FROM profiles WHERE id='unseen'")).points,
      100,
    );
    assert.equal(
      (await row("SELECT points FROM profiles WHERE id='senior'")).points,
      100,
    );
  });
});
test("failed fanout rolls back the question, so retry cannot leave an orphan question", async (t) => {
  const f = fixture();
  t.after(() => f.sqlite.close());
  mockAI(t);
  const author = await f.person("author");
  await f.person("helper");
  f.sqlite.exec(
    "CREATE TRIGGER reject_request BEFORE INSERT ON requests BEGIN SELECT RAISE(ABORT,'test failure'); END",
  );
  await f.run(async () => {
    await assert.rejects(() => createQuestion(author, input));
    assert.equal((await row("SELECT COUNT(*) n FROM questions")).n, 0);
  });
});
test("session cookies enforce private actions and reject cross-origin mutations", async (t) => {
  const f = fixture();
  t.after(() => f.sqlite.close());
  const credentials = {
    email: "student@example.test",
    password: "test-password-123",
  };
  const request = (
    path: string,
    value: unknown,
    cookie = "",
    origin = "http://localhost:8787",
  ) =>
    new Request("http://localhost:8787/api/" + path, {
      method: "POST",
      headers: { "content-type": "application/json", origin, cookie },
      body: JSON.stringify(value),
    });
  const signup = request("auth/signup", credentials);
  const response = await f.run(() => POST(signup), signup);
  assert.equal(response.status, 200);
  const cookie = response.headers.get("set-cookie")!.split(";")[0];
  assert.match(response.headers.get("set-cookie")!, /HttpOnly/);
  const profile = request(
    "profile",
    {
      name: "테스트",
      studentId: "20260001",
      department: "컴퓨터공학과",
      role: "freshman",
      location: "",
    },
    cookie,
  );
  assert.equal((await f.run(() => POST(profile), profile)).status, 200);
  const state = new Request("http://localhost:8787/api/state", {
    headers: { cookie },
  });
  const result = await f.run(() => GET(state), state);
  const data: any = await result.json();
  assert.equal(data.profile.points, 100);
  assert.equal(data.profile.authId, undefined);
  const foreign = request("profile", {}, cookie, "https://evil.example");
  assert.equal((await f.run(() => POST(foreign), foreign)).status, 403);
  const anonymous = request("questions", input);
  assert.equal((await f.run(() => POST(anonymous), anonymous)).status, 401);
  const logout = request("auth/logout", {}, cookie);
  assert.equal((await f.run(() => POST(logout), logout)).status, 200);
  assert.equal(
    ((await (await f.run(() => GET(state), state)).json()) as any)
      .authenticated,
    false,
  );
});
test("webhook retry preserves conversation stage and durable reply retries separately", async (t) => {
  const f = fixture();
  t.after(() => f.sqlite.close());
  await f.person("student");
  let sends = 0;
  t.mock.method(globalThis, "fetch", async (url: string) => {
    if (url.includes("/users/"))
      return Response.json({ user: { memberId: "student" } });
    sends++;
    return new Response("", { status: 503 });
  });
  const request = () =>
    new Request("http://localhost:8787/api/channel/webhook?token=test-hook", {
      method: "POST",
      body: JSON.stringify({
        event: "push",
        type: "message",
        entity: {
          id: "message1",
          chatId: "chat1",
          personId: "channel-user",
          personType: "user",
          chatType: "userChat",
          plainText: "식당 자리 있나요?",
        },
      }),
    });
  await f.run(async () => {
    await channelWebhook(request());
    await channelWebhook(request());
    assert.equal(
      (await row("SELECT stage FROM channel_drafts WHERE chat_id='chat1'"))
        .stage,
      "target",
    );
    await deliverChannelReplies();
    assert.equal(sends, 1);
    assert.equal(
      (await row("SELECT status FROM events")).status,
      "reply_pending",
    );
  });
});
test("senior thresholds, cooldown, stale locations and point reach caps", () => {
  const now = Date.now(),
    p = {
      id: "s",
      role: "senior",
      department: "컴퓨터공학과",
      location: "학생회관",
      locationAt: now,
    } as Profile;
  const analysis = {
    realtime: true,
    answerType: "yes_no",
    department: "컴퓨터공학과",
    location: "학생회관",
    tags: [],
  } as const;
  const a = { ...analysis, tags: [] };
  const stats = { sent: 10, answered: 9, today: 0, lastSent: 0 };
  assert.equal(rankCandidate(a, p, [], "질문", stats, now).eligible, true);
  assert.equal(
    rankCandidate(a, p, [], "질문", { ...stats, lastSent: now }, now).eligible,
    false,
  );
  assert.equal(
    rankCandidate(
      a,
      { ...p, locationAt: now - 3600000 },
      [],
      "질문",
      stats,
      now,
    ).eligible,
    false,
  );
  assert.equal(reach(-10), 3);
  assert.equal(reach(9999), 20);
});

test("Naver POI geocoding, Haversine distance, and real-time location updates", async (t) => {
  // 1. POI Map Lookup
  const poi = findSKKUPoiCoordinates("학생회관");
  assert.notEqual(poi, null);
  assert.equal(poi?.lat, 37.2940);
  assert.equal(poi?.lng, 126.9750);

  // 2. Haversine distance calculation (between Student Union and Samsung Library)
  const dist = haversineDistance(37.2940, 126.9750, 37.2936, 126.9743);
  assert.ok(dist > 50 && dist < 150); // ~75 meters

  // 3. Resolve location coordinates for SKKU Campus text
  const resolved = await resolveLocationCoordinates("학생회관", "학생회관에 사람 많나요?");
  assert.equal(resolved.lat, 37.2940);
  assert.equal(resolved.lng, 126.9750);

  // 4. API & DB tests
  const f = fixture();
  t.after(() => f.sqlite.close());
  mockAI(t);

  const author = await f.person("author");
  const respondent = await f.person("respondent");

  await f.run(async () => {
    // Respondent updates real-time GPS location near Student Union
    const locReq = new Request("http://localhost:8787/api/location", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost:8787" },
      body: JSON.stringify({ lat: 37.2941, lng: 126.9751, locationName: "학생회관 앞" }),
    });

    // Run POST /api/location as respondent
    const profileRow = await row("SELECT * FROM profiles WHERE id=?", respondent.id);
    await db().prepare("UPDATE profiles SET lat=37.2941, lng=126.9751, location='학생회관 앞', location_at=? WHERE id=?")
      .bind(Date.now(), respondent.id).run();

    // Author posts question "학생회관에 사람 많나요?"
    const qRes = await createQuestion(author, {
      title: "학생회관에 사람 많나요?",
      body: "식당 좌석 상황 궁금합니다.",
      department: "전체 학과",
      location: "학생회관",
      targetHint: "",
      realtime: true,
      requestId: "geo-req-1",
    });

    assert.equal(qRes.question.lat, 37.2940);
    assert.equal(qRes.question.lng, 126.9750);

    // Check delivered recommendation candidate request reason
    const reqRow = await row("SELECT * FROM requests WHERE question_id=?", qRes.question.id);
    assert.notEqual(reqRow, null);
    assert.match(reqRow.reason, /근처|거리/);
  });
});

