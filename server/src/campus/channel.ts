import type { D1PreparedStatement } from "@cloudflare/workers-types";
import { db, row, rows, setting, AppError, secureEqual } from "./server.js";
import { createQuestion } from "./service.js";

async function channel(path: string, method = "GET", payload?: unknown) {
  const key = setting("CHANNEL_ACCESS_KEY"),
    secret = setting("CHANNEL_ACCESS_SECRET");
  if (!key || !secret || key === "local-test-key") {
    if (path.startsWith("/users/")) {
      const personId = path.split("/users/")[1];
      const p = await row("SELECT * FROM profiles WHERE id=?", personId);
      return { user: { memberId: p ? p.id : personId } };
    }
    if (path.includes("/messages")) {
      return { ok: true };
    }
    return { ok: true };
  }
  const response = await fetch("https://api.channel.io/open/v5" + path, {
    method,
    headers: {
      "x-access-key": key,
      "x-access-secret": secret,
      "Content-Type": "application/json",
    },
    body: payload ? JSON.stringify(payload) : undefined,
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) {
    if (path.startsWith("/users/")) {
      const personId = path.split("/users/")[1];
      const p = await row("SELECT * FROM profiles WHERE id=?", personId);
      return { user: { memberId: p ? p.id : personId } };
    }
    throw new AppError("채널톡 Open API 연결이 필요해요.", 503);
  }
  return response.json() as Promise<any>;
}
async function sendReply(event: any) {
  const claim = await db()
    .prepare(
      `UPDATE events SET created_at=? WHERE id=? AND status='reply_pending' AND created_at<=?`,
    )
    .bind(Date.now() + 60000, event.id, Date.now())
    .run();
  if (!claim.meta.changes) return;
  try {
    await channel(
      "/user-chats/" +
        encodeURIComponent(event.chatId) +
        "/messages?botName=" +
        encodeURIComponent("스꾸핑"),
      "POST",
      {
        blocks: [
          {
            type: "text",
            value: event.replyText
              .replace(/&/g, "&amp;")
              .replace(/</g, "&lt;")
              .replace(/>/g, "&gt;"),
          },
        ],
      },
    );
    await db()
      .prepare(`UPDATE events SET status='done' WHERE id=?`)
      .bind(event.id)
      .run();
  } catch {
    /* Durable reply remains queued. A timeout after delivery can produce a duplicate chat reply. */
  }
}
export async function deliverChannelReplies() {
  for (const event of await rows(
    `SELECT * FROM events WHERE status='reply_pending' AND created_at<=? ORDER BY created_at LIMIT 10`,
    Date.now(),
  ))
    await sendReply(event);
}
export async function channelWebhook(request: Request) {
  const secret = setting("CHANNEL_WEBHOOK_TOKEN");
  if (
    !secret ||
    !(await secureEqual(
      new URL(request.url).searchParams.get("token") || "",
      secret,
    ))
  )
    throw new AppError("Webhook 인증 실패", 401);
  if (setting("CHANNEL_INTAKE_MODE") === "alf")
    return Response.json({ ignored: true, mode: "alf" });
  const text = await request.text();
  if (text.length > 128000) throw new AppError("요청이 너무 커요.", 413);
  let event: any;
  try {
    event = JSON.parse(text);
  } catch {
    throw new AppError("올바른 Webhook JSON이 아니에요.");
  }
  const message = event.entity;
  if (
    event.event !== "push" ||
    event.type !== "message" ||
    message?.chatType !== "userChat" ||
    message?.personType !== "user"
  )
    return Response.json({ ignored: true });
  if (
    typeof message.id !== "string" ||
    typeof message.chatId !== "string" ||
    typeof message.personId !== "string"
  )
    throw new AppError("메시지 형식이 올바르지 않아요.");
  const content = String(message.plainText || "").trim();
  if (!content || content.length > 3000)
    return Response.json({ ignored: true });
  const id = "channel:" + message.id,
    now = Date.now();
  const previous = await row("SELECT * FROM events WHERE id=?", id);
  if (previous?.status === "done" || previous?.status === "reply_pending")
    return Response.json({ duplicate: true });
  await db()
    .prepare(
      `INSERT OR IGNORE INTO events(id,status,created_at) VALUES(?,'pending',?)`,
    )
    .bind(id, now)
    .run();
  const claim = await db()
    .prepare(
      `UPDATE events SET status='processing',created_at=? WHERE id=? AND (status='pending' OR (status='processing' AND created_at<?))`,
    )
    .bind(now, id, now - 90000)
    .run();
  if (!claim.meta.changes)
    throw new AppError("같은 메시지가 처리 중이에요.", 503);
  const writes: D1PreparedStatement[] = [];
  // Commit the next conversation state and its reply together; retries never consume the same answer twice.
  async function finish(reply: string) {
    writes.push(
      db()
        .prepare(
          `UPDATE events SET status='reply_pending',reply_text=?,chat_id=?,created_at=? WHERE id=?`,
        )
        .bind(reply, message.chatId, Date.now(), id),
    );
    await db().batch(writes);
    return Response.json({ ok: true });
  }
  try {
    const data = await channel(
      "/users/" + encodeURIComponent(message.personId),
    );
    const p = data.user?.memberId
      ? await row("SELECT * FROM profiles WHERE id=?", data.user.memberId)
      : null;
    if (!p)
      return await finish(
        "사이트에서 로그인하고 캠퍼스 프로필을 등록한 뒤 질문해 주세요.",
      );
    if (p.role !== "freshman")
      return await finish(
        "선배 회원은 게시판에서 새내기의 질문에 답변할 수 있어요. 질문 등록은 새내기 회원만 가능해요.",
      );
    let draft = await row(
      "SELECT * FROM channel_drafts WHERE chat_id=?",
      message.chatId,
    );
    if (draft && (draft.userId !== p.id || now - draft.createdAt > 3600000)) {
      writes.push(
        db()
          .prepare("DELETE FROM channel_drafts WHERE chat_id=?")
          .bind(message.chatId),
      );
      draft = null;
    }
    if (content === "취소") {
      writes.push(
        db()
          .prepare("DELETE FROM channel_drafts WHERE chat_id=?")
          .bind(message.chatId),
      );
      return await finish(
        "질문 작성을 취소했어요. 새 질문을 보내면 다시 시작할게요.",
      );
    }
    if (!draft) {
      if (content.length < 3)
        return await finish("질문 내용을 세 글자 이상으로 알려주세요.");
      writes.push(
        db()
          .prepare(
            `INSERT INTO channel_drafts(chat_id,user_id,body,target_hint,stage,created_at) VALUES(?,?,?,'','target',?)`,
          )
          .bind(message.chatId, p.id, content, now),
      );
      return await finish(
        '어떤 사람이 답해주면 좋을까요? 예: 지금 학생회관 식당에 있는 사람, 컴퓨터공학과 선배. 없으면 "없음", 취소하려면 "취소"라고 보내주세요.',
      );
    }
    if (draft.stage === "target") {
      const hint = content === "없음" ? "" : content.slice(0, 300);
      writes.push(
        db()
          .prepare(
            `UPDATE channel_drafts SET target_hint=?,stage='confirm' WHERE chat_id=?`,
          )
          .bind(hint, message.chatId),
      );
      return await finish(
        "게시판에 공개할 질문: " +
          draft.body +
          "\n답변 희망: " +
          (hint || "관련 경험이 있는 사람") +
          '\n이대로 질문을 등록할까요? "네" 또는 "취소"라고 보내주세요.',
      );
    }
    if (!["네", "예", "등록", "응"].includes(content))
      return await finish(
        '등록하려면 "네", 다시 작성하려면 "취소"라고 보내주세요.',
      );
    const result = await createQuestion(
      p,
      {
        title: draft.body.slice(0, 140),
        body: draft.body,
        department: "전체 학과",
        location: "",
        targetHint: draft.targetHint,
        realtime: false,
        requestId: id,
      },
      message.chatId,
    );
    writes.push(
      db()
        .prepare("DELETE FROM channel_drafts WHERE chat_id=?")
        .bind(message.chatId),
    );
    return await finish(
      (result.question.aiAnswer
        ? "이전 답변을 참고한 AI 안내:\n" + result.question.aiAnswer
        : "질문을 등록했어요. 관련 학과·경험·최근 위치를 바탕으로 답변자를 찾고 있어요.") +
        (setting("APP_ORIGIN")
          ? "\n질문 보기: " +
            setting("APP_ORIGIN") +
            "/?question=" +
            result.question.id
          : ""),
    );
  } catch (error) {
    await db()
      .prepare(
        `UPDATE events SET status='pending' WHERE id=? AND status='processing'`,
      )
      .bind(id)
      .run();
    throw error;
  }
}
