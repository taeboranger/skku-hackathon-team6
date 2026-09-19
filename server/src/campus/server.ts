import { AsyncLocalStorage } from "node:async_hooks";
import type { D1Database } from "@cloudflare/workers-types";
import type { Profile } from "./domain.js";
import { sessionUser } from "./auth.js";

export type CampusBindings = { DB: D1Database; [key: string]: unknown };
const context = new AsyncLocalStorage<{
  bindings: CampusBindings;
  request?: Request;
}>();
export function withCampus<T>(
  bindings: CampusBindings,
  request: Request | undefined,
  fn: () => T,
): T {
  return context.run({ bindings, request }, fn);
}
export function currentRequest() {
  return context.getStore()?.request;
}
export function setting(key: string): string {
  return String(context.getStore()?.bindings[key] || process.env[key] || "");
}
export function db() {
  const binding = context.getStore()?.bindings.DB;
  if (!binding)
    throw new AppError("데이터 저장소가 아직 연결되지 않았어요.", 503);
  return binding;
}
export class AppError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}
export function camel(value: any): any {
  if (!value) return value;
  return Object.fromEntries(
    Object.entries(value).map(([k, v]) => [
      k.replace(/_([a-z])/g, (_, l: string) => l.toUpperCase()),
      v,
    ]),
  );
}
export async function rows(sql: string, ...args: any[]): Promise<any[]> {
  const r = await db()
    .prepare(sql)
    .bind(...args)
    .all();
  return r.results.map(camel);
}
export async function row(sql: string, ...args: any[]): Promise<any> {
  return camel(
    await db()
      .prepare(sql)
      .bind(...args)
      .first(),
  );
}
export async function identity() {
  const u = await sessionUser();
  if (!u) throw new AppError("로그인 후 이용해 주세요.", 401);
  return u;
}
export async function profile(): Promise<Profile> {
  const u = await identity();
  const p = await row("SELECT * FROM profiles WHERE auth_id=?", u.userId);
  if (!p) throw new AppError("먼저 캠퍼스 프로필을 등록해 주세요.", 403);
  return p;
}
export function guardOrigin(request: Request) {
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin)
    throw new AppError("허용되지 않은 요청이에요.", 403);
}
export async function body(request: Request) {
  guardOrigin(request);
  const t = await request.text();
  if (t.length > 16000) throw new AppError("입력이 너무 길어요.", 413);
  try {
    return JSON.parse(t);
  } catch {
    throw new AppError("올바른 요청이 아니에요.");
  }
}
export function fail(e: unknown) {
  if (e instanceof AppError)
    return Response.json({ error: e.message }, { status: e.status });
  if (e instanceof Error && e.message.includes("UNIQUE constraint"))
    return Response.json({ error: "이미 등록된 항목이에요." }, { status: 409 });
  console.error("Campus API error message:", e instanceof Error ? e.message : String(e));
  console.error("Campus API error stack:", e instanceof Error ? e.stack : "");
  return Response.json(
    { error: "처리하지 못했어요. 잠시 뒤 다시 시도해 주세요." },
    { status: 503 },
  );
}
export async function digest(value: string) {
  return Buffer.from(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  ).toString("hex");
}
export async function secureEqual(a: string, b: string) {
  if (!a || !b) return false;
  const x = await digest(a),
    y = await digest(b);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}
export async function hmac(value: string, secret: string, hexKey = false) {
  const raw = hexKey
    ? Uint8Array.from(secret.match(/.{2}/g) || [], (b) => parseInt(b, 16))
    : new TextEncoder().encode(secret);
  const key = await crypto.subtle.importKey(
    "raw",
    raw,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return Buffer.from(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value)),
  ).toString("hex");
}
