// 예시 질문 데이터를 로컬 D1에 넣는다.
//
//   corepack pnpm db:seed           로컬 D1에 시드
//   corepack pnpm db:seed --clean   시드만 삭제
//   corepack pnpm db:seed --remote  원격 D1 (운영진 전용, 확인 프롬프트 있음)
//
// 모든 시드 행은 id가 `seed-`로 시작하므로 사용자 데이터와 섞이지 않고,
// 다시 실행하면 지웠다 새로 넣어 몇 번을 돌려도 결과가 같다.
import { pbkdf2Sync } from "node:crypto";
import { spawnSync } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";

const argv = process.argv.slice(2);
const remote = argv.includes("--remote");
const cleanOnly = argv.includes("--clean");

// server/src/campus/auth.ts 의 passwordHash 와 동일해야 로그인이 된다.
// PBKDF2-SHA256 / 100,000회 / 256비트 / hex
const SEED_PASSWORD = "seedpass1234";
const passwordHash = (password, salt) =>
  pbkdf2Sync(password, salt, 100000, 32, "sha256").toString("hex");

const q = (v) =>
  v === null || v === undefined ? "NULL" : `'${String(v).replace(/'/g, "''")}'`;
const n = (v) => (v === null || v === undefined ? "NULL" : String(v));
const MIN = 60_000;
const HOUR = 60 * MIN;
const now = Date.now();

/* ── 사람 ──────────────────────────────────────────────────────────── */
const people = [
  {
    id: "seed-p1",
    name: "김민준",
    role: "freshman",
    dept: "컴퓨터공학과",
    points: 120,
    loc: "중앙도서관",
  },
  {
    id: "seed-p2",
    name: "이서연",
    role: "freshman",
    dept: "경영학과",
    points: 95,
    loc: "경영관",
  },
  {
    id: "seed-p3",
    name: "박지호",
    role: "freshman",
    dept: "전자공학과",
    points: 140,
    loc: "제2공학관",
  },
  {
    id: "seed-p4",
    name: "최수빈",
    role: "freshman",
    dept: "디자인학과",
    points: 80,
    loc: "예술관",
  },
  {
    id: "seed-s1",
    name: "정하은",
    role: "senior",
    dept: "컴퓨터공학과",
    points: 310,
    loc: "제1공학관",
  },
  {
    id: "seed-s2",
    name: "한지우",
    role: "senior",
    dept: "경영학과",
    points: 260,
    loc: "학생회관",
  },
  {
    id: "seed-s3",
    name: "오태윤",
    role: "senior",
    dept: "전자공학과",
    points: 205,
    loc: "제2공학관",
  },
];

/* ── 질문: 8개 분류 × 3개 ──────────────────────────────────────────── */
// [제목, 본문, 분류, 학과, 장소, 실시간, 답변형식, 태그]
const questions = [
  [
    "전공 필수 재수강하면 성적 어디까지 올라가나요?",
    "1학년 때 C+ 받은 전공 필수를 재수강하려는데, 학칙상 최대 몇 점까지 받을 수 있는지 궁금해요.",
    "수업·학점",
    "컴퓨터공학과",
    "",
    0,
    "short",
    ["재수강", "학점", "전공필수"],
  ],
  [
    "자료구조 A반이랑 B반 중에 과제 부담 어디가 적나요?",
    "두 분반 모두 시간표가 맞는데 과제량 차이가 크다고 들었어요. 들어보신 분 계실까요?",
    "수업·학점",
    "컴퓨터공학과",
    "",
    0,
    "text",
    ["수강신청", "분반", "과제"],
  ],
  [
    "수강신청 장바구니 담아두면 우선권이 있나요?",
    "장바구니에 담아두면 자동으로 신청되는 건지, 아니면 그냥 즐겨찾기 기능인지 헷갈려요.",
    "수업·학점",
    "전체 학과",
    "",
    0,
    "yes_no",
    ["수강신청", "장바구니"],
  ],

  [
    "지금 중앙도서관 노트북 열람실 자리 있나요?",
    "콘센트 있는 자리로 가려는데 지금 많이 찼을까요? 바로 출발하려고요.",
    "시설·장소",
    "전체 학과",
    "중앙도서관",
    1,
    "short",
    ["도서관", "열람실", "자리"],
  ],
  [
    "제2공학관 강의실 번호 체계가 어떻게 되나요?",
    "23504호를 찾는데 2층인지 5층인지 모르겠어요. 앞자리가 층수인가요?",
    "시설·장소",
    "전자공학과",
    "제2공학관",
    0,
    "short",
    ["강의실", "건물", "길찾기"],
  ],
  [
    "교내 와이파이 인증서 오류 계속 나는데 해결법 있나요?",
    "노트북에서만 인증서 신뢰 오류가 뜨고 휴대폰은 잘 붙어요. 설정 바꿔야 하나요?",
    "시설·장소",
    "전체 학과",
    "",
    0,
    "text",
    ["와이파이", "네트워크"],
  ],

  [
    "지금 학생회관 식당 줄 많이 긴가요?",
    "12시 10분인데 지금 가면 얼마나 기다려야 할까요?",
    "식당·카페",
    "전체 학과",
    "학생회관",
    1,
    "short",
    ["학식", "혼잡도", "점심"],
  ],
  [
    "기숙사 식당 주말에도 운영하나요?",
    "토요일 아침에도 문 여는지, 연다면 몇 시부터인지 알고 싶어요.",
    "식당·카페",
    "전체 학과",
    "기숙사",
    0,
    "short",
    ["기숙사", "식당", "운영시간"],
  ],
  [
    "학교 근처 조용하게 과제할 만한 카페 있을까요?",
    "노트북 오래 써도 눈치 안 보이는 곳이면 좋겠어요. 콘센트도 있으면 좋고요.",
    "식당·카페",
    "전체 학과",
    "정문",
    0,
    "text",
    ["카페", "과제", "공부"],
  ],

  [
    "재학증명서 온라인으로 뽑으면 바로 나오나요?",
    "내일 제출해야 하는데 온라인 발급도 직인이 찍혀 나오는지 궁금해요.",
    "행정·장학",
    "전체 학과",
    "",
    0,
    "yes_no",
    ["증명서", "발급"],
  ],
  [
    "국가장학금 2차 신청 놓치면 교내장학금도 못 받나요?",
    "2차 신청 기간을 놓쳤는데 교내장학금 심사에도 영향이 있는지 걱정돼요.",
    "행정·장학",
    "전체 학과",
    "",
    0,
    "text",
    ["장학금", "국가장학금"],
  ],
  [
    "휴학계 내면 등록금 반환은 언제 되나요?",
    "개강 2주차에 휴학하면 얼마나 돌려받는지, 입금까지 얼마나 걸리는지 알고 싶어요.",
    "행정·장학",
    "전체 학과",
    "",
    0,
    "text",
    ["휴학", "등록금", "환불"],
  ],

  [
    "2학기에도 동아리 신입 모집하나요?",
    "1학기에 못 들어갔는데 2학기 추가 모집하는 동아리가 있는지 궁금해요.",
    "동아리·행사",
    "전체 학과",
    "학생회관",
    0,
    "yes_no",
    ["동아리", "모집"],
  ],
  [
    "학과 MT 안 가면 불이익 있나요?",
    "일정이 겹쳐서 못 갈 것 같은데 조모임이나 선후배 관계에서 곤란할까요?",
    "동아리·행사",
    "경영학과",
    "",
    0,
    "text",
    ["MT", "학과행사"],
  ],
  [
    "축제 부스 신청은 어디서 하나요?",
    "소모임 단위로 부스를 내고 싶은데 신청 창구랑 마감일을 모르겠어요.",
    "동아리·행사",
    "전체 학과",
    "",
    0,
    "text",
    ["축제", "부스", "신청"],
  ],

  [
    "컴공 2학년인데 지금부터 인턴 준비하면 이른가요?",
    "주변에서 3학년부터 한다고 하는데, 2학년 여름방학 인턴도 현실적인지 궁금해요.",
    "취업·진로",
    "컴퓨터공학과",
    "",
    0,
    "text",
    ["인턴", "취업준비"],
  ],
  [
    "교내 취업지원센터 자소서 첨삭 예약 어떻게 하나요?",
    "홈페이지에서 예약 메뉴를 못 찾겠어요. 방문 예약만 되는 건가요?",
    "취업·진로",
    "전체 학과",
    "학생회관",
    0,
    "text",
    ["취업지원센터", "자소서"],
  ],
  [
    "대학원 진학하려면 학점 몇 점대는 되어야 하나요?",
    "동일 전공 대학원 기준으로 보통 어느 정도 학점을 보는지 알고 싶어요.",
    "취업·진로",
    "전체 학과",
    "",
    0,
    "text",
    ["대학원", "진학", "학점"],
  ],

  [
    "지금 셔틀버스 몇 분 뒤에 오나요?",
    "정문 정류장인데 방금 한 대 놓쳤어요. 배차 간격이 얼마나 되나요?",
    "생활·교통",
    "전체 학과",
    "정문",
    1,
    "short",
    ["셔틀버스", "교통"],
  ],
  [
    "학교 근처 자취방 보증금 시세가 어느 정도인가요?",
    "원룸 기준으로 보증금과 월세가 보통 얼마 선인지 궁금해요.",
    "생활·교통",
    "전체 학과",
    "",
    0,
    "text",
    ["자취", "원룸", "시세"],
  ],
  [
    "학생회관에서 지갑 잃어버렸는데 분실물센터 어디인가요?",
    "어제 저녁에 잃어버린 것 같아요. 어디로 문의하면 될까요?",
    "생활·교통",
    "전체 학과",
    "학생회관",
    0,
    "short",
    ["분실물", "지갑"],
  ],

  [
    "교내에 택배 보관함 있나요?",
    "기숙사생이 아닌데 학교로 택배를 받을 수 있는 곳이 있는지 궁금해요.",
    "기타",
    "전체 학과",
    "",
    0,
    "yes_no",
    ["택배", "보관함"],
  ],
  [
    "교내에서 자전거 대여할 수 있나요?",
    "캠퍼스가 넓어서 자전거를 쓰고 싶은데 대여 제도가 있는지 모르겠어요.",
    "기타",
    "전체 학과",
    "",
    0,
    "yes_no",
    ["자전거", "대여"],
  ],
  [
    "학생증 없이 도서관 출입 가능한가요?",
    "학생증을 집에 두고 왔는데 모바일 학생증으로도 게이트가 열리나요?",
    "기타",
    "전체 학과",
    "중앙도서관",
    0,
    "yes_no",
    ["도서관", "출입", "학생증"],
  ],
];

/* ── 답변 몇 개 ────────────────────────────────────────────────────── */
// [질문 index, 답변자 id, 본문]
const answers = [
  [
    0,
    "seed-s1",
    "재수강은 A0까지만 받을 수 있어요. 성적표에는 재수강 표기가 남고 기존 학점은 평점에서 빠집니다.",
  ],
  [
    2,
    "seed-s1",
    "우선권은 없어요. 장바구니는 신청 시간에 빠르게 담으라고 있는 기능이라 실제 경쟁은 그대로예요.",
  ],
  [4, "seed-s3", "앞의 2는 건물, 3은 층이에요. 23504호면 제2공학관 3층입니다."],
  [7, "seed-s2", "주말에는 아침을 안 하고 점심만 11시 30분부터 운영해요."],
  [
    9,
    "seed-s2",
    "온라인 발급도 전자직인이 찍혀서 바로 제출 가능해요. 다만 기관에 따라 원본을 요구하기도 합니다.",
  ],
  [
    12,
    "seed-s2",
    "9월 초에 2학기 추가 모집하는 동아리가 꽤 있어요. 학생회관 1층 게시판에 공고가 붙습니다.",
  ],
  [
    20,
    "seed-s3",
    "학생회관 1층 안내데스크에서 분실물을 보관해요. 평일 9시부터 6시까지 문의 가능합니다.",
  ],
];

/* ── SQL 생성 ──────────────────────────────────────────────────────── */
const ids = { q: (i) => `seed-q${i + 1}`, a: (i) => `seed-a${i + 1}` };

// FK 순서대로 지운다.
const clean = [
  "DELETE FROM answers WHERE id LIKE 'seed-%';",
  "DELETE FROM requests WHERE id LIKE 'seed-%';",
  "DELETE FROM questions WHERE id LIKE 'seed-%';",
  "DELETE FROM ledger WHERE id LIKE 'seed-%';",
  "DELETE FROM profiles WHERE id LIKE 'seed-%';",
  "DELETE FROM campus_sessions WHERE account_id LIKE 'seed-%';",
  "DELETE FROM campus_accounts WHERE id LIKE 'seed-%';",
];

const insert = [];
for (const [i, p] of people.entries()) {
  // 시드 사용자로 바로 로그인할 수 있게 실제 계정도 함께 만든다.
  const accountId = `seed-acc-${p.id}`;
  const salt = `seed-salt-${p.id}`;
  p.email = `${p.id}@skku.test`;
  insert.push(
    `INSERT INTO campus_accounts(id,email,password_hash,salt,created_at) VALUES(${q(accountId)},${q(p.email)},${q(passwordHash(SEED_PASSWORD, salt))},${q(salt)},${n(now - 30 * 86400000)});`,
  );
  insert.push(
    `INSERT INTO profiles(id,auth_id,name,role,department,student_id,points,location,location_at,created_at) VALUES(${q(p.id)},${q(accountId)},${q(p.name)},${q(p.role)},${q(p.dept)},${q(String(2024001 + i))},${n(p.points)},${q(p.loc)},${n(now - 10 * MIN)},${n(now - 30 * 86400000)});`,
  );
  // expire()가 ledger 합계로 points를 다시 계산하므로 맞춰 둔다.
  insert.push(
    `INSERT INTO ledger(id,user_id,delta,reason,created_at) VALUES(${q("seed-l-" + p.id)},${q(p.id)},${n(p.points)},'시드 데이터',${n(now - 30 * 86400000)});`,
  );
}

for (const [i, row] of questions.entries()) {
  const [title, body, category, dept, loc, realtime, answerType, tags] = row;
  const author = people[i % 4].id; // freshman 4명이 돌아가며 작성
  const createdAt = now - (i + 1) * 37 * MIN;
  insert.push(
    `INSERT INTO questions(id,author_id,request_id,title,body,category,department,location,target_hint,realtime,answer_type,tags,ai_answer,sources,status,channel_chat_id,lat,lng,created_at) ` +
      `VALUES(${q(ids.q(i))},${q(author)},${q("seed-req-" + (i + 1))},${q(title)},${q(body)},${q(category)},${q(dept)},${q(loc)},'',${n(realtime)},${q(answerType)},${q(JSON.stringify(tags))},NULL,'[]','open',NULL,NULL,NULL,${n(createdAt)});`,
  );
}

for (const [i, [qi, author, body]] of answers.entries()) {
  insert.push(
    `INSERT INTO answers(id,question_id,author_id,body,created_at) VALUES(${q(ids.a(i))},${q(ids.q(qi))},${q(author)},${q(body)},${n(now - (qi + 1) * 30 * MIN + 12 * MIN)});`,
  );
}

const sql = [...clean, ...(cleanOnly ? [] : insert)].join("\n") + "\n";

// --print-sql: 실행하지 않고 SQL 만 내보낸다.
// wrangler 가 없는 환경(AWS EC2 등)에 그대로 적용할 때 쓴다.
if (argv.includes("--print-sql")) {
  process.stdout.write(sql);
  process.exit(0);
}

/* ── 실행 ──────────────────────────────────────────────────────────── */
if (remote) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(
    "원격 D1에 시드 데이터를 적용합니다. 계속하려면 'remote' 를 입력하세요: ",
  );
  rl.close();
  if (answer.trim() !== "remote") {
    console.error("취소했습니다.");
    process.exit(1);
  }
}

const file = join(tmpdir(), `campus-seed-${process.pid}.sql`);
writeFileSync(file, sql, "utf8");
try {
  const args = [
    "d1",
    "execute",
    "DB",
    remote ? "--remote" : "--local",
    `--file=${file}`,
  ];
  const r = spawnSync("wrangler", args, {
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (r.error) throw r.error;
  if (r.status !== 0) process.exit(r.status ?? 1);
} finally {
  try {
    unlinkSync(file);
  } catch {}
}

console.log(
  cleanOnly
    ? "시드 데이터를 삭제했습니다."
    : `시드 완료: 사용자 ${people.length}명, 질문 ${questions.length}개(분류 8종), 답변 ${answers.length}개.\n` +
        `로그인: ${people.map((p) => p.email).join(", ")} / 비밀번호 ${SEED_PASSWORD}`,
);
