import { z } from "zod";
import { db, rows, row, AppError } from "./server.js";
import { analyze, groundedAnswer } from "./ai.js";
import { reach, rankCandidate, similarity, type Profile } from "./domain.js";
import { resolveLocationCoordinates } from "./naver.js";
export const questionInput = z.object({
  title: z.string().trim().min(3).max(140),
  body: z.string().trim().min(2).max(3000),
  department: z.string().trim().max(80).default("전체 학과"),
  location: z.string().trim().max(80).default(""),
  targetHint: z.string().trim().max(300).default(""),
  realtime: z.boolean().default(false),
  requestId: z.string().min(8).max(160),
});
export const qSelect = `SELECT q.*,p.name AS author_name,(SELECT COUNT(*) FROM answers a WHERE a.question_id=q.id) AS answer_count FROM questions q JOIN profiles p ON p.id=q.author_id`;
export function unpack(q: any) {
  return q
    ? {
        ...q,
        sources: JSON.parse(q.sources || "[]"),
        tags: JSON.parse(q.tags || "[]"),
      }
    : q;
}
export async function question(id: string) {
  return unpack(await row(qSelect + " WHERE q.id=?", id));
}
export async function expire() {
  const now = Date.now();
  await db().batch([
    db()
      .prepare(
        `INSERT OR IGNORE INTO ledger(id,user_id,delta,reason,created_at) SELECT 'expired:'||r.id,r.user_id,-3,'답변 요청 기한 내 미응답',? FROM requests r JOIN profiles p ON p.id=r.user_id JOIN questions q ON q.id=r.question_id WHERE r.status='pending' AND r.expires_at<? AND r.seen_at IS NOT NULL AND p.role='freshman' AND q.status='open' AND NOT EXISTS(SELECT 1 FROM answers a WHERE a.question_id=r.question_id AND a.author_id=r.user_id)`,
      )
      .bind(now, now),
    db()
      .prepare(
        `UPDATE requests SET status='expired' WHERE status='pending' AND expires_at<?`,
      )
      .bind(now),
    db().prepare(
      `UPDATE profiles SET points=MAX(0,COALESCE((SELECT SUM(delta) FROM ledger WHERE user_id=profiles.id),100))`,
    ),
    db().prepare(
      `UPDATE deliveries SET status='cancelled' WHERE status IN ('pending','sending') AND request_id IN (SELECT id FROM requests WHERE status<>'pending')`,
    ),
  ]);
}
export async function createQuestion(
  p: Profile,
  input: unknown,
  channelChatId: string | null = null,
) {
  if (p.role !== "freshman")
    throw new AppError("선배 회원은 답변만 등록할 수 있어요.", 403);
  const v = questionInput.parse(input);
  const existing = await row(
    "SELECT id FROM questions WHERE author_id=? AND request_id=?",
    p.id,
    v.requestId,
  );
  if (existing)
    return { question: await question(existing.id), duplicate: true };
  const now = Date.now();
  const count = await row(
    "SELECT COUNT(*) AS n FROM questions WHERE author_id=? AND created_at>?",
    p.id,
    now - 3600000,
  );
  if (count.n >= 10)
    throw new AppError("한 시간에 질문은 10개까지 등록할 수 있어요.", 429);

  const a = await analyze(v);
  const coords = await resolveLocationCoordinates(a.location, v.title + " " + v.body);
  a.lat = coords.lat;
  a.lng = coords.lng;

  let generated: { answer: string; sources: string[] } | null = null;
  if (!a.realtime) {
    const past = await rows(
      `SELECT q.id,q.title,q.body,group_concat(a.body,char(10)) AS answers FROM questions q JOIN answers a ON a.question_id=q.id WHERE q.realtime=0 AND q.created_at>? GROUP BY q.id ORDER BY q.created_at DESC LIMIT 150`,
      now - 180 * 86400000,
    );
    const candidates = past
      .map((h) => ({
        ...h,
        similarity: similarity(v.title + " " + v.body, h.title + " " + h.body),
      }))
      .filter((h) => h.similarity > 0.24)
      .sort((x, y) => y.similarity - x.similarity)
      .slice(0, 5);
    try {
      generated = await groundedAnswer(v.title + " " + v.body, candidates);
    } catch {
      generated = null;
    }
  }
  const id = crypto.randomUUID();
  const writes = [
    db()
      .prepare(
        `INSERT INTO questions(id,author_id,request_id,title,body,department,location,target_hint,realtime,answer_type,tags,ai_answer,sources,status,channel_chat_id,lat,lng,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,'open',?,?,?,?)`,
      )
      .bind(
        id,
        p.id,
        v.requestId,
        v.title,
        v.body,
        a.department,
        a.location,
        v.targetHint,
        a.realtime ? 1 : 0,
        a.answerType,
        JSON.stringify(a.tags),
        generated?.answer || null,
        JSON.stringify(generated?.sources || []),
        channelChatId,
        coords.lat,
        coords.lng,
        now,
      ),
  ];

  if (!generated) {
    const people = await rows("SELECT * FROM profiles WHERE id<>?", p.id);
    const history = await rows(
      `SELECT q.author_id,q.title,q.body FROM questions q WHERE EXISTS(SELECT 1 FROM answers a WHERE a.question_id=q.id) ORDER BY q.created_at DESC LIMIT 1000`,
    );
    const stats = await rows(
      `SELECT user_id,COUNT(*) AS sent,SUM(CASE WHEN status='answered' THEN 1 ELSE 0 END) AS answered,SUM(CASE WHEN created_at>? THEN 1 ELSE 0 END) AS today,MAX(created_at) AS last_sent FROM requests GROUP BY user_id`,
      now - 86400000,
    );
    const ranked = people
      .map((person) =>
        rankCandidate(
          a,
          person,
          history.filter((h) => h.authorId === person.id),
          v.title + " " + v.body,
          stats.find((s) => s.userId === person.id) || {
            sent: 0,
            answered: 0,
            today: 0,
            lastSent: 0,
          },
          now,
        ),
      )
      .filter((r) => r.eligible)
      .sort((x, y) => y.score - x.score)
      .slice(0, reach(p.points));
    for (const candidate of ranked) {
      const rid = id + ":" + candidate.id;
      writes.push(
        db()
          .prepare(
            `INSERT INTO requests(id,question_id,user_id,reason,score,status,expires_at,created_at) VALUES(?,?,?,?,?,'pending',?,?)`,
          )
          .bind(
            rid,
            id,
            candidate.id,
            candidate.reason,
            Math.round(candidate.score * 100),
            now + (a.realtime ? 15 * 60000 : 3600000),
            now,
          ),
      );
      const subs = await rows(
        "SELECT endpoint FROM subscriptions WHERE user_id=?",
        candidate.id,
      );
      for (const s of subs) {
        writes.push(
          db()
            .prepare(
              `INSERT INTO deliveries(id,request_id,endpoint,status,attempts,next_at,created_at) VALUES(?,?,?,'pending',0,?,?)`,
            )
            .bind(crypto.randomUUID(), rid, s.endpoint, now, now),
        );
      }
    }
  }
  try {
    await db().batch(writes);
  } catch (error) {
    const duplicate = await row(
      "SELECT id FROM questions WHERE author_id=? AND request_id=?",
      p.id,
      v.requestId,
    );
    if (duplicate)
      return { question: await question(duplicate.id), duplicate: true };
    throw error;
  }
  return { question: await question(id) };
}
export async function answerQuestion(p: Profile, input: unknown) {
  const v = z
    .object({
      questionId: z.string().max(100),
      body: z.string().trim().min(1).max(2000),
    })
    .parse(input);
  const q = await question(v.questionId);
  if (!q) throw new AppError("질문을 찾을 수 없어요.", 404);
  if (q.status !== "open") throw new AppError("이미 해결된 질문이에요.", 409);
  const now = Date.now();
  const id = crypto.randomUUID();
  await db().batch([
    db()
      .prepare(
        `INSERT OR IGNORE INTO answers(id,question_id,author_id,body,created_at) SELECT ?,?,?,?,? WHERE EXISTS(SELECT 1 FROM questions WHERE id=? AND status='open')`,
      )
      .bind(id, q.id, p.id, v.body, now, q.id),
    db()
      .prepare(
        `INSERT OR IGNORE INTO ledger(id,user_id,delta,reason,created_at) SELECT ?,?,10,'질문에 답변',? WHERE EXISTS(SELECT 1 FROM answers WHERE id=?) AND ?<>?`,
      )
      .bind("answer:" + q.id + ":" + p.id, p.id, now, id, p.id, q.authorId),
    db()
      .prepare(
        `UPDATE requests SET status='answered' WHERE question_id=? AND user_id=? AND status='pending' AND EXISTS(SELECT 1 FROM answers WHERE question_id=? AND author_id=?)`,
      )
      .bind(q.id, p.id, q.id, p.id),
    db()
      .prepare(
        `UPDATE profiles SET points=MAX(0,COALESCE((SELECT SUM(delta) FROM ledger WHERE user_id=?),100)) WHERE id=?`,
      )
      .bind(p.id, p.id),
  ]);
  const saved = await row(
    "SELECT id FROM answers WHERE question_id=? AND author_id=?",
    q.id,
    p.id,
  );
  if (!saved) throw new AppError("질문이 종료되었어요.", 409);
  return { ok: true, duplicate: saved.id !== id };
}
