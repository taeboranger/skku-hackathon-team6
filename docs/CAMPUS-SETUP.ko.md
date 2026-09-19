# 캠퍼스 핑 개발 & 자율 가이드 (운영진 요청 없이 독립 실행)

본 문서는 **성균관대 해커톤 팀6 (SKKU 2026 Team6)**의 **캠퍼스 핑 (Campus Ping)** 프로젝트 분석 및 개발 자율화 통합 가이드입니다.  
개발 폴더는 `team6/`입니다.

---

## 1. 프로젝트 분석 및 완성 현황

Codex가 진행하던 캠퍼스 핑 프로젝트의 전체 구조를 분석하고, 로컬 환경에서 외부 의존성(OpenAI, 채널톡 Open API 등) 없이 완전하게 동작하도록 보완 및 빌드·검증을 마쳤습니다.

### 🧩 전체 시스템 구성

| 구분 | 위치 | 용도 및 특징 |
| --- | --- | --- |
| **웹 프런트엔드** | `web/` | React, Vite, Tailwind CSS, Radix UI 기반의 새내기/선배 가입, 질문 게시판, 요청 알림함, 포인트 통계 UI |
| **서버 & API** | `server/src/campus/` | D1 SQLite ORM, 회원 인증(세션/패스워드), 질문 분류/매칭 로직, Web Push, 채널톡 Webhook |
| **App SDK Function** | `server/src/campus.functions.ts` | `campus.searchAnswers`, `campus.submitQuestion`, `campus.listQuestions` (Manager 전용) |
| **WAM 패널** | `wam/src/pages/Campus.tsx` | 채널톡 데스크 Manager 화면용 실시간 질문 현황 리스트 패널 |
| **DB 마이그레이션** | `cloudflare/migrations/0002_campus.sql` | `profiles`, `questions`, `answers`, `requests`, `ledger`, `events` 등 캠퍼스 핑 핵심 테이블 |
| **로컬 검증 스크립트** | `scripts/smoke-campus.mjs` | HMAC 서명 기반 API 및 Function 엔드포인트 자동 검증 |

---

## 2. 운영진 요청 없이 작업을 가능하게 한 변경 사항

기존에는 DB 마이그레이션 적용, Worker 비밀키(Secrets) 등록, Function 재등록, 채널톡 Webhook 설정을 위해 **운영진에게 매번 요청서**를 전달해야 했습니다.  
이를 개선하여 **개발자가 100% 자율적으로 로컬 및 원격 작업을 수행**할 수 있도록 다음 시스템 변경을 적용했습니다.

### 🛠 변경된 핵심 기능

1. **로컬 개발 환경의 완전 자동 생성 (`setup-campus-local.mjs`)**
   - `node scripts/setup-campus-local.mjs` 실행 시 로컬 실행에 필요한 `APP_ID`, `SIGNING_KEY`, `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `CHANNEL_WEBHOOK_TOKEN`, `CRON_SECRET` 등이 `.dev.vars`에 자동 생성됩니다.
2. **OpenAI API Key 미설정 시 오프라인 폴백 (Local AI Fallback)**
   - `server/src/campus/ai.ts` 변경: `OPENAI_API_KEY`가 없거나 로컬 더미 상태이더라도 503 에러로 멈추지 않고, **로컬 규칙 기반 질문 분류(실시간/학과/장소/태그)**로 자동 전환됩니다.
3. **채널톡 Open API 미설정 시 오프라인 모의 응답 (Local Channeltalk Mock)**
   - `server/src/campus/channel.ts` 변경: `CHANNEL_ACCESS_KEY`가 없더라도 채널톡 Webhook 테스트 시 유저 조회(`SELECT FROM profiles`) 및 메시지 발송이 **로컬 모의 로그**로 동작하여 100% 로컬에서 채널톡 대화 흐름을 테스트할 수 있습니다.
4. **자율 원격 DB 마이그레이션 및 비밀키 관리 지원**
   - Cloudflare CLI/계정 권한이 있을 경우, 운영진을 거치지 않고 직접 `corepack pnpm exec wrangler d1 migrations apply DB --remote` 명령으로 원격 D1 DB에 SQL을 즉시 적용할 수 있습니다.
5. **독자적인 스모크 검증 도구 (`smoke-campus.mjs`)**
   - `corepack pnpm test:campus` 실행만으로 ALF 검색, Manager WAM 조회 권한, API인증, 웹 서버 정상 동작을 직접 자동 검증합니다.

---

## 3. 로컬 환경 실행 및 개발 절차 (Quick Start)

### Step 1. 의존성 설치 및 환경 설정
```powershell
# team6 디렉토리에서 실행
corepack pnpm install --frozen-lockfile

# 로컬 비밀 키 (.dev.vars) 자동 생성
node scripts/setup-campus-local.mjs
```

### Step 2. 전체 패키지 빌드
```powershell
# 웹, 서버, WAM, 공유 패키지 일괄 빌드
corepack pnpm -r build
node scripts/build-cloudflare.mjs
```

### Step 3. 로컬 DB 마이그레이션 적용
```powershell
# 로컬 Cloudflare D1 (SQLite)에 마이그레이션 실행
corepack pnpm db:migrate:local
```

### Step 4. 로컬 서버 실행
```powershell
# Wrangler local worker 실행 (기본 포트: http://localhost:8787)
corepack pnpm dev:cloudflare
```

*(웹 UI만 HMR로 빠르게 개발하고 싶다면 별도 터미널에서 `corepack pnpm --filter @campus/web dev` 실행 후 `http://localhost:5173` 접속)*

---

## 4. 기능 검증 및 테스트 가이드

### 1) 자동화 스모크 테스트 실행
서버가 8787 포트에서 실행 중일 때 다른 터미널에서 다음 명령을 실행합니다:
```powershell
corepack pnpm test:campus
```
*출력 예시:* `PASS: ALF search realtime bypass, manager WAM query, caller restrictions, API authentication, website`

### 2) 웹 화면 시나리오 테스트
1. 브라우저에서 `http://localhost:8787/` (또는 Vite dev 이용 시 `http://localhost:5173/`) 접속.
2. **새내기 회원 가입 (계정 A)**:
   - 이메일/비밀번호 가입 후 프로필 작성 (역할: 새내기, 학과: 컴퓨터공학과, 위치: 학생회관).
3. **질문 등록 (A)**:
   - "지금 학생회관 식당에 자리 있나요?" 입력 후 등록. (실시간 질문 ⚡ 표시 확인)
4. **새내기/선배 회원 가입 (계정 B)**:
   - 다른 시크릿 창에서 계정 B 가입 (동일 학과/위치 설정).
5. **요청함 확인 및 답변 (B)**:
   - 계정 B의 [답변 요청함] 탭에 A의 질문이 노출되는지 확인 후 답변 작성.
   - 답변 완료 시 B 계정에 포인트(+10P) 적립 확인.

---

## 5. 채널톡 (Channel Talk) 연동 상세 설정 가이드

채널톡 연동은 **(1) 웹 메신저 연동**, **(2) 고객 대화 Webhook**, **(3) 개발자 포털 데스크 앱(WAM)** 3가지 영역으로 구분됩니다.

### 🔑 필요한 환경 변수 (키 목록)

| 변수명 | 위치 (발급처) | 용도 |
| --- | --- | --- |
| `CHANNEL_PLUGIN_KEY` | 채널톡 대시보드 → 설정 → 버튼 및 채팅 → 플러그인 키 | 웹 화면 우측 하단 채널톡 채팅 버튼 로드 |
| `CHANNEL_MEMBER_HASH_SECRET` | 채널톡 대시보드 → 설정 → 보안 → Member Hash Secret | 고객 보안 식별 (MemberHash HMAC 생성) |
| `CHANNEL_ACCESS_KEY` | 채널톡 대시보드 → 설정 → Open API 관리 | 백엔드가 채널톡 Open API로 유저 정보 조회 |
| `CHANNEL_ACCESS_SECRET` | 채널톡 대시보드 → 설정 → Open API 관리 | 백엔드가 채널톡 Open API로 봇 답변 메시지 전송 |
| `CHANNEL_WEBHOOK_TOKEN` | 개발자가 지정하는 비밀 문자열 | Webhook URL 보안 검증 토큰 |

### 📝 환경 변수 설정 위치

* **로컬 개발 (`team6/.dev.vars`)**:
  ```dotenv
  CHANNEL_PLUGIN_KEY=your_plugin_key
  CHANNEL_MEMBER_HASH_SECRET=your_member_hash_secret
  CHANNEL_ACCESS_KEY=your_access_key
  CHANNEL_ACCESS_SECRET=your_access_secret
  CHANNEL_WEBHOOK_TOKEN=your_webhook_token
  ```
* **원격 배포 (Cloudflare Worker Secret)**:
  ```powershell
  corepack pnpm exec wrangler secret put CHANNEL_PLUGIN_KEY
  corepack pnpm exec wrangler secret put CHANNEL_MEMBER_HASH_SECRET
  corepack pnpm exec wrangler secret put CHANNEL_ACCESS_KEY
  corepack pnpm exec wrangler secret put CHANNEL_ACCESS_SECRET
  corepack pnpm exec wrangler secret put CHANNEL_WEBHOOK_TOKEN
  ```

### 🔗 Webhook URL 및 이벤트 설정
채널톡 대시보드 또는 개발자 포털에 Webhook URL을 등록합니다:
* **URL 양식**: `https://<Worker주소>/api/channel/webhook?token=<CHANNEL_WEBHOOK_TOKEN>`
* **이벤트 조건**: `event=push`, `type=message`, `entity.chatType=userChat`, `entity.personType=user`

---

## 6. 원격 배포 및 자율 마이그레이션 가이드

운영진에게 요청하지 않고 본인/팀 Cloudflare 계정에 직접 배포할 경우 다음 명령어들을 사용합니다.

### 1) 원격 DB 마이그레이션 직접 실행
```powershell
corepack pnpm exec wrangler d1 migrations apply DB --remote
```

### 2) Worker 환경 변수 (Secrets) 직접 설정
```powershell
corepack pnpm exec wrangler secret put OPENAI_API_KEY
corepack pnpm exec wrangler secret put CHANNEL_WEBHOOK_TOKEN
```

### 3) App SDK Function 직접 등록
```powershell
corepack pnpm --filter @tutorial/server register
```

---

## 7. 백업용: 운영진 전달 서식 (필요한 경우에만 활용)

공용 성균관대 해커톤 배포 서버(`skku-team6.skku-hackathon-2026.workers.dev`)에 운영진이 직접 배포해주는 방식을 사용할 경우에만 아래 양식을 전달하세요.

```text
팀6 캠퍼스 핑 연동 요청입니다.
1. team6의 cloudflare/migrations/0002_campus.sql 원격 적용을 요청합니다.
   DB: skku-team6 / 4f49239e-4283-49fa-8a08-335d546a8bfa
2. OPENAI_API_KEY, CHANNEL_PLUGIN_KEY, CHANNEL_MEMBER_HASH_SECRET,
   CHANNEL_ACCESS_KEY, CHANNEL_ACCESS_SECRET, CHANNEL_WEBHOOK_TOKEN,
   VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT, CRON_SECRET,
   APP_ORIGIN을 skku-team6 Worker에 설정해 주세요.
3. 배포 후 pnpm register로 campus.listQuestions 추가 등록을 요청합니다.
```
