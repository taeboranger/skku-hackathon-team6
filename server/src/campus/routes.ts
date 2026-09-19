import { z } from "zod";
import { sessionUser, authRoute } from "./auth.js";
import {
  db,
  row,
  rows,
  profile,
  identity,
  body,
  fail,
  AppError,
  setting,
  hmac,
  secureEqual,
} from "./server.js";
import {
  qSelect,
  unpack,
  question,
  createQuestion,
  answerQuestion,
  expire,
} from "./service.js";
import { aiKey } from "./ai.js";
import { deliverPush, validEndpoint } from "./push.js";
import { channelWebhook } from "./channel.js";
import { resolveLocationCoordinates } from "./naver.js";

export async function GET(request: Request) {
  try {
    const path = new URL(request.url).pathname.slice(5);
    if (path === "state") {
      const u = await sessionUser();
      const p = u
        ? await row("SELECT * FROM profiles WHERE auth_id=?", u.userId)
        : null;
      return Response.json({
        authenticated: !!u,
        profile: p ? { ...p, authId: undefined } : null,
        questions: (
          await rows(qSelect + " ORDER BY q.created_at DESC LIMIT 100")
        ).map(unpack),
        requests: p
          ? (
              await rows(
                qSelect.replace(
                  "SELECT q.*,",
                  "SELECT q.*,r.id AS request_id,r.reason,r.expires_at,",
                ) +
                  ` JOIN requests r ON r.question_id=q.id WHERE r.user_id=? AND r.status='pending' AND r.expires_at>? AND q.status='open' ORDER BY r.created_at DESC`,
                p.id,
                Date.now(),
              )
            ).map(unpack)
          : [],
        ledger: p
          ? await rows(
              "SELECT * FROM ledger WHERE user_id=? ORDER BY created_at DESC LIMIT 50",
              p.id,
            )
          : [],
        config: {
          vapidPublicKey: setting("VAPID_PUBLIC_KEY"),
          channelReady: !!setting("CHANNEL_PLUGIN_KEY"),
          channelPluginKey: setting("CHANNEL_PLUGIN_KEY"),
          aiReady: !!aiKey(),
        },
      });
    }
    if (path.startsWith("questions/")) {
      const id = path.slice(10);
      const q = await question(id);
      if (!q) throw new AppError("질문이 없어요.", 404);
      return Response.json({
        question: q,
        answers: await rows(
          "SELECT a.id,a.body,a.created_at,p.name,p.role FROM answers a JOIN profiles p ON p.id=a.author_id WHERE a.question_id=? ORDER BY a.created_at",
          id,
        ),
      });
    }
    if (path === "channel") {
      const p = await profile();
      const pluginKey = setting("CHANNEL_PLUGIN_KEY");
      if (!pluginKey)
        throw new AppError(
          "채널톡 플러그인 키(CHANNEL_PLUGIN_KEY) 설정이 필요해요.",
          503,
        );
      const secret = setting("CHANNEL_MEMBER_HASH_SECRET");
      return Response.json({
        pluginKey,
        memberId: p.id,
        memberHash: secret ? await hmac(p.id, secret, true) : undefined,
        profile: { name: p.name, department: p.department, role: p.role },
      });
    }
    throw new AppError("페이지를 찾을 수 없어요.", 404);
  } catch (e) {
    return fail(e);
  }
}
export async function POST(request: Request) {
  try {
    const path = new URL(request.url).pathname.slice(5);
    if (path === "channel/webhook") return await channelWebhook(request);
    if (path === "jobs") {
      if (
        !(await secureEqual(
          request.headers.get("authorization") || "",
          "Bearer " + setting("CRON_SECRET"),
        )) ||
        !setting("CRON_SECRET")
      )
        throw new AppError("인증이 필요해요.", 401);
      await expire();
      return Response.json(await deliverPush());
    }
    const v = await body(request);
    if (path.startsWith("auth/")) return await authRoute(path, request, v);
    if (path === "profile") {
      const u = await identity();
      const p = z
        .object({
          name: z.string().trim().min(1).max(30),
          role: z.enum(["freshman", "senior"]),
          department: z.string().trim().min(1).max(80),
          studentId: z.string().regex(/^\d{4,12}$/),
          location: z.string().trim().max(80).default(""),
          lat: z.number().nullable().optional(),
          lng: z.number().nullable().optional(),
        })
        .parse(v);
      const old = await row("SELECT * FROM profiles WHERE auth_id=?", u.userId);
      const id = old?.id || crypto.randomUUID();
      if (old && old.role !== p.role)
        throw new AppError("가입 후 회원 구분은 변경할 수 없어요.", 403);
      const now = Date.now();
      let lat = p.lat ?? null;
      let lng = p.lng ?? null;
      if ((lat == null || lng == null) && p.location) {
        const coords = await resolveLocationCoordinates(p.location);
        lat = coords.lat;
        lng = coords.lng;
      }
      await db().batch([
        db()
          .prepare(
            `INSERT INTO profiles(id,auth_id,name,role,department,student_id,points,location,location_at,lat,lng,created_at) VALUES(?,?,?,?,?,?,100,?,?,?,?,?) ON CONFLICT(auth_id) DO UPDATE SET name=excluded.name,department=excluded.department,student_id=excluded.student_id,location=excluded.location,location_at=excluded.location_at,lat=excluded.lat,lng=excluded.lng`,
          )
          .bind(
            id,
            u.userId,
            p.name,
            p.role,
            p.department,
            p.studentId,
            p.location,
            now,
            lat,
            lng,
            now,
          ),
        db()
          .prepare(
            `INSERT OR IGNORE INTO ledger(id,user_id,delta,reason,created_at) VALUES(?,?,100,'가입 포인트',?)`,
          )
          .bind("signup:" + id, id, now),
      ]);
      return Response.json({ ok: true, lat, lng });
    }
    const p = await profile();
    if (path === "location") {
      const loc = z
        .object({
          lat: z.number().min(-90).max(90),
          lng: z.number().min(-180).max(180),
          locationName: z.string().trim().max(80).optional(),
        })
        .parse(v);
      const now = Date.now();
      const locationName = loc.locationName || p.location;
      await db()
        .prepare(
          `UPDATE profiles SET lat=?, lng=?, location=?, location_at=? WHERE id=?`,
        )
        .bind(loc.lat, loc.lng, locationName, now, p.id)
        .run();
      return Response.json({
        ok: true,
        lat: loc.lat,
        lng: loc.lng,
        locationAt: now,
      });
    }
    if (path === "questions") {
      await expire();
      const result = await createQuestion(p, v);
      await deliverPush();
      return Response.json(result);
    }
    if (path === "answers") {
      if (v.recipientId && v.recipientId !== p.id)
        throw new AppError("알림을 받은 계정으로 로그인해 주세요.", 403);
      const result = await answerQuestion(p, v);
      return Response.json(result);
    }
    if (path === "seen") {
      const rid = z.string().max(200).parse(v.requestId);
      await db()
        .prepare(
          `UPDATE requests SET seen_at=?,expires_at=MAX(expires_at,?) WHERE id=? AND user_id=? AND status='pending' AND seen_at IS NULL AND expires_at>?`,
        )
        .bind(Date.now(), Date.now() + 10 * 60000, rid, p.id, Date.now())
        .run();
      return Response.json({ ok: true });
    }
    if (path === "resolve") {
      const q = await question(z.string().parse(v.questionId));
      if (!q || q.authorId !== p.id)
        throw new AppError("본인 질문만 해결 완료할 수 있어요.", 403);
      await db().batch([
        db()
          .prepare(
            `UPDATE questions SET status='closed' WHERE id=? AND author_id=?`,
          )
          .bind(q.id, p.id),
        db()
          .prepare(
            `UPDATE requests SET status='cancelled' WHERE question_id=? AND status='pending'`,
          )
          .bind(q.id),
        db()
          .prepare(
            `UPDATE deliveries SET status='cancelled' WHERE request_id IN (SELECT id FROM requests WHERE question_id=?) AND status IN ('pending','sending')`,
          )
          .bind(q.id),
      ]);
      return Response.json({ ok: true });
    }
    if (path === "push") {
      const s = z
        .object({
          endpoint: z.string().url().max(2000),
          keys: z.object({
            p256dh: z
              .string()
              .regex(/^[A-Za-z0-9_-]+$/)
              .max(200),
            auth: z
              .string()
              .regex(/^[A-Za-z0-9_-]+$/)
              .max(100),
          }),
        })
        .parse(v.subscription);
      if (!validEndpoint(s.endpoint))
        throw new AppError("지원하지 않는 푸시 서비스예요.");
      const now = Date.now();
      await db().batch([
        db()
          .prepare(
            `INSERT INTO subscriptions(endpoint,user_id,p256dh,auth,created_at) VALUES(?,?,?,?,?) ON CONFLICT(endpoint) DO UPDATE SET user_id=excluded.user_id,p256dh=excluded.p256dh,auth=excluded.auth`,
          )
          .bind(s.endpoint, p.id, s.keys.p256dh, s.keys.auth, now),
        db()
          .prepare(
            `INSERT OR REPLACE INTO deliveries(id,request_id,endpoint,status,attempts,next_at,created_at) SELECT r.id||':'||?,r.id,?, 'pending',0,?,? FROM requests r JOIN questions q ON q.id=r.question_id WHERE r.user_id=? AND r.status='pending' AND r.expires_at>? AND q.status='open'`,
          )
          .bind(
            crypto.randomUUID().slice(0, 8),
            s.endpoint,
            now,
            now,
            p.id,
            now,
          ),
      ]);
      await deliverPush();
      return Response.json({ ok: true });
    }
    if (path === "tick") {
      await expire();
      return Response.json(await deliverPush());
    }
    throw new AppError("지원하지 않는 요청이에요.", 404);
  } catch (e) {
    if (e instanceof z.ZodError)
      return Response.json(
        { error: "입력 형식과 길이를 확인해 주세요." },
        { status: 400 },
      );
    return fail(e);
  }
}
