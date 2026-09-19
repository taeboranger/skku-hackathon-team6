import webpush from "web-push";
import { db, rows, row, setting } from "./server.js";
export function validEndpoint(endpoint: string) {
  try {
    const u = new URL(endpoint);
    return u.protocol === "https:" && !!u.hostname;
  } catch {
    return false;
  }
}
export async function deliverPush() {
  if (!setting("VAPID_PUBLIC_KEY") || !setting("VAPID_PRIVATE_KEY")) {
    console.log("[PUSH] VAPID keys missing in environment.");
    return { sent: 0 };
  }
  const now = Date.now();
  const items = await rows(
    `SELECT d.*,r.user_id,r.expires_at,q.title,q.answer_type,q.id AS question_id FROM deliveries d JOIN requests r ON r.id=d.request_id JOIN questions q ON q.id=r.question_id WHERE d.status IN ('pending','sending') AND d.next_at<=? AND d.attempts<10 AND r.status='pending' AND r.expires_at>? AND q.status='open' LIMIT 20`,
    now,
    now,
  );
  let sent = 0;
  for (const d of items) {
    const claim = await db()
      .prepare(
        `UPDATE deliveries SET status='sending',next_at=?,attempts=attempts+1 WHERE id=? AND next_at<=? AND status IN ('pending','sending')`,
      )
      .bind(now + 60000, d.id, now)
      .run();
    if (!claim.meta.changes) continue;
    try {
      const sub = await row(
        "SELECT * FROM subscriptions WHERE endpoint=? AND user_id=?",
        d.endpoint,
        d.userId,
      );
      if (!sub || !validEndpoint(d.endpoint)) {
        console.log("[PUSH] Invalid endpoint or missing subscription:", d.endpoint);
        await db()
          .prepare(`UPDATE deliveries SET status='cancelled' WHERE id=?`)
          .bind(d.id)
          .run();
        continue;
      }
      const payload = JSON.stringify({
        title: "답변을 기다리는 캠퍼스 질문",
        body: d.title,
        questionId: d.questionId,
        recipientId: d.userId,
        requestId: d.requestId,
        answerType: d.answerType,
      });
      const subject = setting("VAPID_SUBJECT") || "mailto:campus@example.com";
      const req = webpush.generateRequestDetails(
        { endpoint: d.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        payload,
        {
          TTL: Math.max(1, Math.floor((d.expiresAt - now) / 1000)),
          vapidDetails: {
            subject: subject.startsWith("mailto:") ? subject : "mailto:" + subject,
            publicKey: setting("VAPID_PUBLIC_KEY"),
            privateKey: setting("VAPID_PRIVATE_KEY"),
          },
        },
      );
      const r = await fetch(req.endpoint, {
        method: "POST",
        headers: req.headers,
        body: req.body as any,
        redirect: "manual",
        signal: AbortSignal.timeout(10000),
      });
      if (r.status === 410 || r.status === 404) {
        console.log("[PUSH] Subscription expired or unregistered (410/404)");
        await db().batch([
          db()
            .prepare("DELETE FROM subscriptions WHERE endpoint=?")
            .bind(d.endpoint),
          db()
            .prepare(`UPDATE deliveries SET status='cancelled' WHERE id=?`)
            .bind(d.id),
        ]);
        continue;
      }
      if (!r.ok) {
        console.error("[PUSH] FCM/Push Server HTTP Error:", r.status, await r.text().catch(() => ""));
        throw Error("Push rejected: " + r.status);
      }
      await db()
        .prepare(`UPDATE deliveries SET status='sent' WHERE id=?`)
        .bind(d.id)
        .run();
      sent++;
      console.log("[PUSH SUCCESS] Push notification delivered to:", d.userId);
    } catch (e) {
      console.error("[PUSH ERROR]", e);
      await db()
        .prepare(`UPDATE deliveries SET status='pending',next_at=? WHERE id=?`)
        .bind(now + Math.min(900000, 30000 * 2 ** d.attempts), d.id)
        .run();
    }
  }
  return { sent };
}
