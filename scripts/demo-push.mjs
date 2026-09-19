// 최수빈(seed-p4) -> 한지우(seed-s2) 로 반드시 알림이 가는 데모 질문을 만든다.
//
//   corepack pnpm db:seed          # 먼저 시드가 있어야 한다
//   corepack pnpm demo:push        # 데모 질문 등록
//
// 한지우는 '선배'라 rankCandidate 문턱이 높다.
//   eligible = score >= 0.65 && 답변률 >= 0.5 && 마지막 발송 후 4시간 경과
// 이 스크립트는 그 세 조건을 모두 만족시키도록 상태를 맞춘 뒤 질문을 올린다.
import { spawnSync } from "node:child_process";

const ORIGIN = process.env.ORIGIN ?? "http://127.0.0.1:8787";
const ASKER = { email: "seed-p4@skku.test", password: "seedpass1234", name: "최수빈" };
const TARGET = { id: "seed-s2", name: "한지우" };

function sql(command) {
  const r = spawnSync(
    "wrangler",
    ["d1", "execute", "DB", "--local", "--json", `--command=${command}`],
    { encoding: "utf8", shell: process.platform === "win32" },
  );
  if (r.status !== 0) throw Error("d1 실패: " + (r.stderr || r.stdout));
  const m = r.stdout.match(/\[[\s\S]*\]/);
  return m ? JSON.parse(m[0])[0]?.results ?? [] : [];
}

let cookie = "";
async function api(path, body) {
  const r = await fetch(`${ORIGIN}/api/${path}`, {
    method: body ? "POST" : "GET",
    headers: {
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const set = r.headers.get("set-cookie");
  if (set) cookie = set.split(";")[0];
  const json = await r.json().catch(() => ({}));
  if (!r.ok) throw Error(`${path} → HTTP ${r.status} ${JSON.stringify(json)}`);
  return json;
}

// 1) 선배 게이팅을 통과할 수 있는 상태로 맞춘다.
//    - 남아 있던 미응답 요청은 답변률을 떨어뜨리고 lastSent 를 최근으로 만든다.
//    - 위치는 30분 이내여야 GPS 가점이 붙는다.
console.log("1. 대상 상태 초기화");
sql(`DELETE FROM deliveries WHERE request_id IN (SELECT id FROM requests WHERE user_id='${TARGET.id}')`);
sql(`DELETE FROM requests WHERE user_id='${TARGET.id}'`);
sql(`UPDATE profiles SET location='학생회관', location_at=${Date.now()}, lat=37.294, lng=126.975 WHERE id='${TARGET.id}'`);
const t = sql(`SELECT name,department,location,lat,lng FROM profiles WHERE id='${TARGET.id}'`)[0];
console.log(`   ${t.name}: ${t.department} / ${t.location} / (${t.lat}, ${t.lng})`);

// 2) 최수빈으로 로그인
console.log(`2. ${ASKER.name} 로그인`);
await api("auth/login", { email: ASKER.email, password: ASKER.password });

// 3) 학과와 장소를 명시해서 가점을 확정시킨다.
//    department/location 은 사용자가 지정하면 AI 판정보다 우선한다.
//    과거 Q&A 로 답할 수 없는 주제여야 groundedAnswer 가 비고 fanout 이 돈다.
console.log("3. 데모 질문 등록");
const { question } = await api("questions", {
  title: "경영학과 팀플용 스터디룸을 학생회관에서 예약하려면 어떻게 하나요?",
  body:
    "이번 주에 팀 프로젝트 회의를 해야 하는데 학생회관 스터디룸을 빌릴 수 있는지, " +
    "예약 창구와 가능한 시간대가 어떻게 되는지 궁금해요.",
  department: "경영학과",
  location: "학생회관",
  realtime: false,
  requestId: crypto.randomUUID(),
});
console.log(`   id=${question.id} / category=${question.category} / realtime=${!!question.realtime}`);
if (question.aiAnswer) {
  console.log("   ⚠ AI 가 과거 답변으로 답해버려서 fanout 이 돌지 않았습니다.");
  console.log("     질문 내용을 더 새로운 주제로 바꾸세요.");
  process.exit(1);
}

// 4) 결과 확인
console.log("4. 알림 대상 확인");
const sent = sql(
  `SELECT r.user_id, p.name, p.role, r.score, r.reason, r.status, r.expires_at
   FROM requests r JOIN profiles p ON p.id=r.user_id
   WHERE r.question_id='${question.id}' ORDER BY r.score DESC`,
);
for (const r of sent) {
  const mark = r.user_id === TARGET.id ? " ★" : "";
  console.log(`   - ${r.name}(${r.role}) score=${r.score} ${r.status}${mark}`);
  console.log(`     이유: ${r.reason}`);
}

const hit = sent.find((r) => r.user_id === TARGET.id);
const deliveries = sql(
  `SELECT COUNT(*) AS n FROM deliveries d JOIN requests r ON r.id=d.request_id
   WHERE r.question_id='${question.id}' AND r.user_id='${TARGET.id}'`,
)[0];

console.log("\n────────────────────────");
console.log(`${TARGET.name} 알림함(request) : ${hit ? "✔ 도착" : "✖ 미도착"}`);
console.log(`${TARGET.name} 웹푸시(delivery): ${Number(deliveries.n) > 0 ? "✔ " + deliveries.n + "건 예약" : "✖ 0건 — 구독 없음"}`);
if (!Number(deliveries.n))
  console.log(`  → ${TARGET.name} 로 로그인해 '브라우저 알림 켜기' 를 누르면 구독이 생기고 실제 푸시가 나갑니다.`);
process.exit(hit ? 0 : 1);
