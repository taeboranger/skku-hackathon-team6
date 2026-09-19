import { z } from "zod";
import {
  AppError,
  currentRequest,
  db,
  digest,
  row,
  secureEqual,
} from "./server.js";
const tokenFrom = (r?: Request) =>
  r?.headers
    .get("cookie")
    ?.split(";")
    .map((s) => s.trim())
    .find((s) => s.startsWith("campus_session="))
    ?.slice(15) || "";
export async function sessionUser() {
  const token = tokenFrom(currentRequest());
  if (!token) return null;
  const session = await row(
    "SELECT account_id FROM campus_sessions WHERE token_hash=? AND expires_at>?",
    await digest(token),
    Date.now(),
  );
  return session ? { userId: session.accountId } : null;
}
export async function passwordHash(password: string, salt: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  return Buffer.from(
    await crypto.subtle.deriveBits(
      {
        name: "PBKDF2",
        salt: new TextEncoder().encode(salt),
        iterations: 100000,
        hash: "SHA-256",
      },
      key,
      256,
    ),
  ).toString("hex");
}
export async function authRoute(
  path: string,
  request: Request,
  value: unknown,
) {
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  const cookie = (token: string, age: number) =>
    `campus_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${age}${secure}`;
  if (path === "auth/logout") {
    await db()
      .prepare("DELETE FROM campus_sessions WHERE token_hash=?")
      .bind(await digest(tokenFrom(request)))
      .run();
    return Response.json(
      { ok: true },
      { headers: { "Set-Cookie": cookie("", 0) } },
    );
  }
  if (!["auth/signup", "auth/login"].includes(path))
    throw new AppError("페이지를 찾을 수 없어요.", 404);
  const v = z
    .object({
      email: z
        .string()
        .trim()
        .email()
        .max(254)
        .transform((s) => s.toLowerCase()),
      password: z.string().min(10).max(128),
    })
    .parse(value);
  const now = Date.now();
  // Only Cloudflare's own connecting IP header is used. Email bucket also limits distributed guesses.
  for (const key of [
    "email:" + (await digest(v.email)),
    "ip:" + (await digest(request.headers.get("cf-connecting-ip") || "local")),
  ]) {
    const limit = await db()
      .prepare(
        `INSERT INTO campus_auth_limits(key,count,until_at) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=CASE WHEN until_at<? THEN 1 ELSE count+1 END,until_at=CASE WHEN until_at<? THEN excluded.until_at ELSE until_at END RETURNING count`,
      )
      .bind(key, now + 900000, now, now)
      .first<{ count: number }>();
    if ((limit?.count || 0) > 20)
      throw new AppError("잠시 후 다시 로그인해 주세요.", 429);
  }
  let account = await row(
    "SELECT * FROM campus_accounts WHERE email=?",
    v.email,
  );
  if (path === "auth/signup") {
    if (account)
      throw new AppError(
        "가입할 수 없는 이메일이에요. 로그인을 시도해 주세요.",
        409,
      );
    const salt = crypto.randomUUID(),
      id = crypto.randomUUID();
    await db()
      .prepare(
        "INSERT INTO campus_accounts(id,email,password_hash,salt,created_at) VALUES(?,?,?,?,?)",
      )
      .bind(id, v.email, await passwordHash(v.password, salt), salt, now)
      .run();
    account = { id };
  } else {
    const hash = await passwordHash(
      v.password,
      account?.salt || "unknown-account",
    );
    if (!account || !(await secureEqual(hash, account.passwordHash)))
      throw new AppError("이메일 또는 비밀번호를 확인해 주세요.", 401);
  }
  const token = Buffer.from(
    crypto.getRandomValues(new Uint8Array(32)),
  ).toString("base64url");
  await db().batch([
    db().prepare("DELETE FROM campus_sessions WHERE expires_at<?").bind(now),
    db()
      .prepare(
        "INSERT INTO campus_sessions(token_hash,account_id,expires_at) VALUES(?,?,?)",
      )
      .bind(await digest(token), account.id, now + 7 * 86400000),
  ]);
  return Response.json(
    { ok: true },
    { headers: { "Set-Cookie": cookie(token, 7 * 86400) } },
  );
}
