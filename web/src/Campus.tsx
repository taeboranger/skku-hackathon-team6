"use client";
import { useEffect, useState } from "react";
import {
  Bell,
  Zap,
  MessageCircle,
  ArrowUpRight,
  GraduationCap,
  MapPin,
  Plus,
  Search,
  Users,
  Send,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Toaster, toast } from "sonner";
import { bootChannelTalk, openChannelTalk } from "./channel";
type Q = {
  id: string;
  title: string;
  body: string;
  category: string;
  department: string;
  location: string;
  realtime: number;
  answerType: string;
  createdAt: number;
  authorName: string;
  authorId: string;
  answerCount: number;
  status: string;
  aiAnswer?: string;
  targetHint?: string;
  sources?: string[];
};
type P = {
  id: string;
  name: string;
  role: string;
  department: string;
  studentId: string;
  points: number;
  location: string;
};
// server/src/campus/domain.ts 의 CATEGORIES 와 같은 순서를 유지한다.
const categories = [
  "수업·학점",
  "시설·장소",
  "식당·카페",
  "행정·장학",
  "동아리·행사",
  "취업·진로",
  "생활·교통",
  "기타",
];
// 디버그 로그인용 시드 계정. scripts/seed-campus.mjs 의 people 과 일치해야 한다.
const SEED_PASSWORD = "seedpass1234";
const seedUsers = [
  { id: "seed-p1", name: "김민준", role: "신입생" },
  { id: "seed-p2", name: "이서연", role: "신입생" },
  { id: "seed-p3", name: "박지호", role: "신입생" },
  { id: "seed-p4", name: "최수빈", role: "신입생" },
  { id: "seed-s1", name: "정하은", role: "선배" },
  { id: "seed-s2", name: "한지우", role: "선배" },
  { id: "seed-s3", name: "오태윤", role: "선배" },
];
// 데모용: 배포본에서도 시드 계정으로 바로 로그인할 수 있게 항상 노출한다.
// 공개 URL에 원클릭 로그인이 노출되므로, 운영 전환 시 되돌릴 자리.
const debugMode = true;

// server/src/campus/naver.ts 의 POI_MAP 키워드와 같은 표기를 유지한다.
// 이 이름이 그대로 좌표로 해석되어 '질문 장소 근처' 가점에 쓰인다.
const campusLocations = [
  "학생회관",
  "삼성학술정보관",
  "제1공학관",
  "제2공학관",
  "복지회관",
  "봉룡학사",
  "자연과학관",
  "기초학문관",
  "의학관",
  "약학관",
  "생명공학관",
  "수성관",
  "체육관",
  "정문",
];
const departments = [
  "컴퓨터공학과",
  "경영학과",
  "디자인학과",
  "전자공학과",
  "기계공학과",
  "인문대학",
  "기타",
];
const initialDraft = {
  title: "",
  body: "",
  category: "",
  department: "전체 학과",
  location: "",
  targetHint: "",
  realtime: false,
};
async function api(path: string, body?: unknown): Promise<any> {
  const r = await fetch("/api/" + path, {
    method: body ? "POST" : "GET",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const d: any = await r.json();
  if (!r.ok) throw Error(d.error || "요청을 처리하지 못했어요.");
  return d;
}
function ago(t: number) {
  const m = Math.floor((Date.now() - t) / 60000);
  return m < 1
    ? "방금"
    : m < 60
      ? m + "분 전"
      : m < 1440
        ? Math.floor(m / 60) + "시간 전"
        : Math.floor(m / 1440) + "일 전";
}
export default function Campus() {
  const [data, setData] = useState<{
    profile: P | null;
    authenticated: boolean;
    questions: Q[];
    requests: any[];
    ledger: any[];
    config: any;
  }>({
    profile: null,
    authenticated: false,
    questions: [],
    requests: [],
    ledger: [],
    config: {},
  });
  const [loading, setLoading] = useState(true),
    [error, setError] = useState(""),
    [view, setView] = useState("all"),
    [search, setSearch] = useState(""),
    [category, setCategory] = useState(""),
    [debugOpen, setDebugOpen] = useState(false),
    [modal, setModal] = useState(""),
    [selected, setSelected] = useState<Q | null>(null),
    [answers, setAnswers] = useState<any[]>([]),
    [busy, setBusy] = useState(false),
    [draft, setDraft] = useState(initialDraft),
    [answer, setAnswer] = useState("");
  const [credentials, setCredentials] = useState({ email: "", password: "" });
  const [questionRequestId, setQuestionRequestId] = useState(() =>
    crypto.randomUUID(),
  );
  const [registration, setRegistration] = useState({
    name: "",
    role: "freshman",
    department: departments[0],
    studentId: "",
    location: "",
  });
  async function refresh() {
    try {
      const d = await api("state");
      setData(d);
      setError("");
      return d;
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 20000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    const id = new URLSearchParams(location.search).get("question");
    if (!id) return;
    void api("questions/" + encodeURIComponent(id))
      .then((d) => {
        setSelected(d.question);
        setAnswers(d.answers);
        setModal("detail");
      })
      .catch((e) => toast.error(e.message));
  }, []);
  useEffect(() => {
    if (!data.profile) return;
    const tick = () => void api("tick", {}).catch(() => {});
    tick();
    const t = setInterval(tick, 60000);
    return () => clearInterval(t);
  }, [data.profile?.id]);
  useEffect(() => {
    if (
      !data.profile ||
      typeof navigator === "undefined" ||
      !navigator.geolocation
    )
      return;
    let watchId: number | null = null;
    const sendLocation = (pos: GeolocationPosition) => {
      const lat = pos.coords.latitude;
      const lng = pos.coords.longitude;
      void api("location", { lat, lng }).catch(() => {});
    };
    try {
      watchId = navigator.geolocation.watchPosition(sendLocation, () => {}, {
        enableHighAccuracy: true,
        maximumAge: 30000,
        timeout: 20000,
      });
    } catch {}
    return () => {
      if (watchId !== null) navigator.geolocation.clearWatch(watchId);
    };
  }, [data.profile?.id]);
  useEffect(() => {
    const ctx = (document as any).modelContext;
    if (!ctx?.registerTool) return;
    const c = new AbortController();
    void Promise.resolve(
      ctx.registerTool(
        {
          name: "search_campus_questions",
          description: "게시판에서 질문을 검색합니다.",
          inputSchema: {
            type: "object",
            properties: { query: { type: "string" } },
            required: ["query"],
            additionalProperties: false,
          },
          annotations: { readOnlyHint: true },
          execute: ({ query }: { query: string }) => {
            setSearch(String(query));
            setView("all");
            return { query };
          },
        },
        { signal: c.signal },
      ),
    ).catch(() => {});
    return () => c.abort();
  }, []);
  useEffect(() => {
    const pluginKey = data.config?.channelPluginKey;
    if (!pluginKey) return;
    let cancelled = false;
    void (async () => {
      let member: {
        memberId?: string;
        memberHash?: string;
        profile?: Record<string, unknown>;
      } = {};
      if (data.profile) {
        // 서버만 멤버 해시를 계산할 수 있다. 실패해도 익명으로는 띄운다.
        member = await api("channel").catch(() => ({}));
      }
      if (cancelled) return;
      const status = await bootChannelTalk({
        pluginKey,
        hideDefaultButton: true,
        ...member,
      });
      if (status === "boot-rejected" || status === "load-failed")
        console.warn("[channel-talk]", status);
    })();
    return () => {
      cancelled = true;
    };
  }, [data.config?.channelPluginKey, data.profile?.id]);
  function needProfile() {
    if (!data.authenticated) {
      setModal("login");
      return false;
    }
    if (!data.profile) {
      setModal("profile");
      return false;
    }
    return true;
  }
  function fetchGPSLocation(
    onSuccess: (locName: string, lat?: number, lng?: number) => void,
  ) {
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      toast.error("이 브라우저에서는 GPS 위치를 지원하지 않아요.");
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const lat = pos.coords.latitude;
        const lng = pos.coords.longitude;
        const latStr = lat.toFixed(3);
        const lngStr = lng.toFixed(3);
        onSuccess(`위도 ${latStr}, 경도 ${lngStr}`, lat, lng);
        if (data.profile) {
          void api("location", {
            lat,
            lng,
            locationName: `위도 ${latStr}, 경도 ${lngStr}`,
          }).catch(() => {});
        }
        toast.success("현재 GPS 위치를 가져왔어요!");
      },
      (err) => {
        toast.error("위치 권한을 허용해 주세요: " + err.message);
      },
      { timeout: 10000, enableHighAccuracy: true },
    );
  }
  async function run(fn: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function openQuestion(q: Q) {
    setSelected(q);
    setAnswers([]);
    setAnswer("");
    setModal("detail");
    try {
      const d = await api("questions/" + q.id);
      setAnswers(d.answers);
      setSelected(d.question);
    } catch (e) {
      toast.error((e as Error).message);
    }
  }
  async function submitAnswer(text: string) {
    if (!needProfile() || !selected) return;
    await run(async () => {
      await api("answers", { questionId: selected.id, body: text });
      toast.success("답변을 남겼어요. 고마워요!");
      setAnswer("");
      await refresh();
      const d = await api("questions/" + selected.id);
      setAnswers(d.answers);
      setSelected(d.question);
    });
  }
  async function enablePush() {
    if (!needProfile()) return;
    await run(async () => {
      if (!("serviceWorker" in navigator) || !("PushManager" in window))
        throw Error(
          "이 브라우저는 웹 푸시를 지원하지 않아요. 알림함을 이용해 주세요.",
        );
      if (!data.config.vapidPublicKey)
        throw Error("웹 푸시 서버 연결이 필요해요. 알림함은 사용할 수 있어요.");
      if ((await Notification.requestPermission()) !== "granted")
        throw Error("브라우저 알림 권한이 필요해요.");
      await navigator.serviceWorker.register("/sw.js");
      const sw = await navigator.serviceWorker.ready;
      const key = Uint8Array.from(
        atob(data.config.vapidPublicKey.replace(/-/g, "+").replace(/_/g, "/")),
        (c) => c.charCodeAt(0),
      );
      const sub = await sw.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: key,
      });
      await api("push", { subscription: sub.toJSON() });
      toast.success("이 기기로 답변 요청을 받을 수 있어요.");
    });
  }
  function editProfile() {
    if (needProfile()) {
      const p = data.profile!;
      setRegistration({
        name: p.name,
        role: p.role,
        department: p.department,
        studentId: p.studentId,
        location: p.location,
      });
      setModal("profile");
    }
  }
  const p = data.profile;
  const questions = data.questions.filter(
    (q) =>
      (view !== "urgent" || q.realtime) &&
      (view !== "mine" || q.authorId === p?.id) &&
      (!category || q.category === category) &&
      `${q.title} ${q.body} ${q.department} ${q.category}`.includes(search),
  );
  return (
    <>
      <Toaster richColors position="top-center" />
      <div className="workspace">
        <aside className="left-rail">
          <div className="rail-head">
            <a className="brand rail-brand" href="/">
              <span className="brand-mark" aria-hidden="true">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
                  <circle cx="12" cy="12" r="2.6" fill="currentColor" />
                  <circle
                    cx="12"
                    cy="12"
                    r="6.2"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    opacity="0.75"
                  />
                  <circle
                    cx="12"
                    cy="12"
                    r="9.8"
                    stroke="currentColor"
                    strokeWidth="1.6"
                    opacity="0.4"
                  />
                </svg>
              </span>
              스꾸핑
            </a>
            <button
              className="icon-button"
              aria-label="답변 요청 알림"
              onClick={() => {
                if (needProfile()) setModal("notifications");
              }}
            >
              <Bell size={21} />
              {data.requests.length > 0 && <b className="notification-dot" />}
            </button>
          </div>
          <p className="nav-label">커뮤니티</p>
          <nav>
            {[
              ["all", "전체 질문", MessageCircle],
              ["urgent", "긴급 질문", Zap],
              ["requests", "나에게 온 질문", Bell],
              ["mine", "내가 올린 질문", Users],
            ].map(([key, label, Icon]: any) => (
              <button
                key={key}
                className={view === key ? "active" : ""}
                onClick={() => {
                  if (key === "requests") {
                    if (needProfile()) setModal("notifications");
                  } else if (key !== "mine" || needProfile()) setView(key);
                }}
              >
                <Icon size={19} />
                {label}
              </button>
            ))}
          </nav>
          <div className="rail-divider" />
          <p className="nav-label">내 캠퍼스</p>
          <button
            className="campus-link"
            onClick={() => {
              if (needProfile()) {
                setSearch(p!.department);
                setView("all");
              }
            }}
          >
            <GraduationCap size={19} />
            {p?.department || "우리 학과 질문"}
          </button>
          <button className="campus-link" onClick={editProfile}>
            <MapPin size={19} />
            {p?.location || "내 위치 설정"}
          </button>
        </aside>
        <main className="main" key={view}>
          <div className="page-heading">
            <div>
              <h1>
                {view === "mine"
                  ? "내가 올린 질문"
                  : view === "urgent"
                    ? "긴급 질문"
                    : "전체 질문"}
              </h1>
            </div>
            <button
              className="primary"
              disabled={p?.role === "senior"}
              onClick={() => {
                if (needProfile()) setModal("question");
              }}
            >
              <Plus size={19} />
              {p?.role === "senior"
                ? "선배는 답변으로 함께해요"
                : "질문 올리기"}
            </button>
          </div>
          <div className="feed-tools">
            <div
              className="category-filter"
              role="group"
              aria-label="주제 분류"
            >
              <button
                className={category === "" ? "active" : ""}
                onClick={() => setCategory("")}
              >
                전체
              </button>
              {categories.map((c) => (
                <button
                  key={c}
                  className={category === c ? "active" : ""}
                  onClick={() => setCategory(category === c ? "" : c)}
                >
                  {c}
                </button>
              ))}
            </div>
            <label className="search">
              <Search size={17} />
              <input
                aria-label="질문 검색"
                placeholder="궁금한 내용을 검색해 보세요"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </label>
          </div>
          {error && (
            <div className="notice error">
              {error}
              <button onClick={() => void refresh()}>다시 시도</button>
            </div>
          )}
          {loading && <div className="empty">질문을 불러오고 있어요.</div>}
          <div className="question-feed">
            {questions.map((q) => (
              <button
                className="question-card"
                key={q.id}
                onClick={() => void openQuestion(q)}
              >
                <div className="card-meta">
                  {!!q.realtime && (
                    <span className="tag urgent-tag">
                      <Zap size={12} />
                      실시간
                    </span>
                  )}
                  {q.category && (
                    <span className="tag category-tag">{q.category}</span>
                  )}
                  {q.location && (
                    <span className="muted">
                      <MapPin size={13} />
                      {q.location}
                    </span>
                  )}
                  {q.department && q.department !== "전체 학과" && (
                    <span className="muted">{q.department}</span>
                  )}
                  <span className="card-time">{ago(q.createdAt)}</span>
                </div>
                <div className="card-main">
                  <div className="card-text">
                    <h3>{q.title}</h3>
                    <p>{q.body}</p>
                  </div>
                  <span className="answer-count">
                    <MessageCircle size={15} />
                    답변 {q.answerCount}
                  </span>
                </div>
              </button>
            ))}
          </div>
          {!loading && !error && !questions.length && (
            <div className="empty">
              <MessageCircle size={30} />
              <h3>아직 질문이 없어요.</h3>
              <button
                className="secondary"
                onClick={() => {
                  if (needProfile()) setModal("question");
                }}
              >
                첫 질문 남기기
              </button>
            </div>
          )}
        </main>
        <aside className="right-rail">
          <section className="points-card">
            <div className="section-title">
              <span>나의 도움 포인트</span>
            </div>
            <div className="points">
              {p?.points ?? "—"}
              <small>P</small>
            </div>
            <div className="point-meter">
              <span
                style={{ width: Math.min(100, (p?.points || 0) / 3) + "%" }}
              />
            </div>
            <div className="point-details">
              <span>내 질문 전달 범위</span>
              <b>
                최대{" "}
                {Math.min(20, 3 + Math.floor(Math.max(0, p?.points || 0) / 30))}
                명
              </b>
            </div>
            <button
              onClick={() => {
                if (needProfile()) setModal("points");
              }}
            >
              포인트 내역 보기 <ArrowUpRight size={15} />
            </button>
          </section>
          <section className="request-card">
            <div className="section-title">
              <h2>답변 요청</h2>
              <Bell size={17} />
            </div>
            <p>
              {data.requests.length
                ? `${data.requests.length}개의 답변 요청이 도착했어요.`
                : "받은 요청이 없어요."}
            </p>
            <button className="secondary" onClick={() => void enablePush()}>
              <Bell size={16} />
              브라우저 알림 켜기
            </button>
          </section>
        </aside>
      </div>
      <div className="profile-dock">
        <button className="account-button" onClick={editProfile}>
          {p ? (
            <>
              <span className="avatar">{p.name.slice(0, 1)}</span>
              {p.name}
            </>
          ) : (
            "로그인 / 가입"
          )}
        </button>
      </div>
      {data.config?.channelPluginKey && (
        <button
          className="chat-fab"
          onClick={() => openChannelTalk()}
          aria-label="채널톡으로 문의하기"
        >
          <MessageCircle size={20} />
          문의하기
        </button>
      )}
      {debugMode && (
        <div className={"debug-panel" + (debugOpen ? " open" : "")}>
          <button
            className="debug-toggle"
            onClick={() => setDebugOpen((v) => !v)}
            aria-expanded={debugOpen}
          >
            디버그 {debugOpen ? "▾" : "▸"}
          </button>
          {debugOpen && (
            <div className="debug-body">
              <p>
                시드 계정으로 로그인해요.
                <br />
                <code>corepack pnpm db:seed</code> 를 먼저 실행하세요.
              </p>
              {seedUsers.map((u) => (
                <button
                  key={u.id}
                  onClick={() =>
                    void run(async () => {
                      await api("auth/login", {
                        email: `${u.id}@skku.test`,
                        password: SEED_PASSWORD,
                      });
                      await refresh();
                      toast.success(`${u.name} (${u.role}) 으로 로그인했어요.`);
                    })
                  }
                >
                  <b>{u.name}</b>
                  <span>{u.role}</span>
                </button>
              ))}
              <button
                className="debug-logout"
                onClick={() =>
                  void run(async () => {
                    await api("auth/logout", {});
                    await refresh();
                    toast.success("로그아웃했어요.");
                  })
                }
              >
                로그아웃
              </button>
            </div>
          )}
        </div>
      )}
      <Dialog
        open={!!modal}
        onOpenChange={(open) => {
          if (!open) setModal("");
        }}
      >
        <DialogContent className="campus-dialog">
          <DialogTitle>
            {modal === "login"
              ? "로그인"
              : modal === "signup"
                ? "회원가입"
                : modal === "question"
                  ? "지금, 무엇이 궁금한가요?"
                  : modal === "profile"
                    ? "캠퍼스 프로필"
                    : modal === "notifications"
                      ? "나에게 온 답변 요청"
                      : modal === "points"
                        ? "도움 포인트 내역"
                        : selected?.title || "질문"}
          </DialogTitle>
          <DialogDescription>
            {modal === "question"
              ? "알맞은 사람에게 질문을 전달할게요."
              : modal === "profile"
                ? "학과와 경험이 맞는 질문을 연결하는 데 사용해요."
                : modal === "points"
                  ? "답변 +10P · 새내기는 전달 확인 후 기한 내 미응답 −3P. 선배는 감점이 없어요."
                  : modal === "notifications"
                    ? "답변 요청을 열어 내용을 확인해 주세요."
                    : "캠퍼스 구성원의 경험을 나눠주세요."}
          </DialogDescription>
          {(modal === "login" || modal === "signup") && (
            <form
              className="form"
              onSubmit={(e) => {
                e.preventDefault();
                void run(async () => {
                  await api("auth/" + modal, credentials);
                  await refresh();
                  setModal(modal === "signup" ? "profile" : "");
                  toast.success("로그인했어요.");
                });
              }}
            >
              <label>
                이메일
                <input
                  type="email"
                  required
                  autoComplete="email"
                  value={credentials.email}
                  onChange={(e) =>
                    setCredentials({ ...credentials, email: e.target.value })
                  }
                />
              </label>
              <label>
                비밀번호
                <input
                  type="password"
                  required
                  minLength={10}
                  autoComplete={
                    modal === "signup" ? "new-password" : "current-password"
                  }
                  value={credentials.password}
                  onChange={(e) =>
                    setCredentials({ ...credentials, password: e.target.value })
                  }
                />
                <small>10자 이상 입력해 주세요.</small>
              </label>
              <button className="primary" disabled={busy}>
                {modal === "signup" ? "가입하고 프로필 작성" : "로그인"}
              </button>
              <button
                type="button"
                className="text-button"
                onClick={() =>
                  setModal(modal === "signup" ? "login" : "signup")
                }
              >
                {modal === "signup"
                  ? "이미 계정이 있어요"
                  : "처음이에요 · 회원가입"}
              </button>
            </form>
          )}
          {modal === "profile" && (
            <form
              className="form"
              onSubmit={(e) => {
                e.preventDefault();
                void run(async () => {
                  await api("profile", registration);
                  await refresh();
                  setModal("");
                  toast.success("프로필을 저장했어요.");
                });
              }}
            >
              <label>
                이름
                <input
                  required
                  maxLength={30}
                  value={registration.name}
                  onChange={(e) =>
                    setRegistration({ ...registration, name: e.target.value })
                  }
                />
              </label>
              <label>
                학번
                <input
                  required
                  pattern="[0-9]{4,12}"
                  placeholder="예: 20260001"
                  value={registration.studentId}
                  onChange={(e) =>
                    setRegistration({
                      ...registration,
                      studentId: e.target.value,
                    })
                  }
                />
              </label>
              <label>
                학과
                <select
                  value={registration.department}
                  onChange={(e) =>
                    setRegistration({
                      ...registration,
                      department: e.target.value,
                    })
                  }
                >
                  {departments.map((d) => (
                    <option key={d}>{d}</option>
                  ))}
                </select>
              </label>
              <label>
                구분
                <select
                  disabled={!!p}
                  value={registration.role}
                  onChange={(e) =>
                    setRegistration({ ...registration, role: e.target.value })
                  }
                >
                  <option value="freshman">새내기 · 질문과 답변</option>
                  <option value="senior">선배 · 답변으로 도움 주기</option>
                </select>
              </label>
              <label>
                현재 장소 (선택)
                <div style={{ display: "flex", gap: "8px" }}>
                  <input
                    maxLength={80}
                    placeholder="예: 학생회관, 공학관"
                    value={registration.location}
                    onChange={(e) =>
                      setRegistration({
                        ...registration,
                        location: e.target.value,
                      })
                    }
                  />
                  <button
                    type="button"
                    className="text-button"
                    style={{ whiteSpace: "nowrap", fontSize: "13px" }}
                    onClick={() =>
                      fetchGPSLocation((loc) =>
                        setRegistration((prev) => ({ ...prev, location: loc })),
                      )
                    }
                  >
                    📍 GPS 위치 가져오기
                  </button>
                </div>
                <small>공유한 장소는 30분 동안 추천에 사용돼요.</small>
              </label>
              <button className="primary" disabled={busy}>
                {busy ? "저장 중…" : "프로필 저장"}
              </button>
            </form>
          )}
          {modal === "profile" && p && (
            <button
              className="text-button"
              onClick={() =>
                void run(async () => {
                  await api("auth/logout", {});
                  await refresh();
                  setModal("");
                  const w = window as any;
                  w.ChannelIO?.("shutdown");
                })
              }
            >
              로그아웃
            </button>
          )}
          {modal === "question" && (
            <form
              className="form"
              onSubmit={(e) => {
                e.preventDefault();
                void run(async () => {
                  if (!needProfile()) return;
                  await api("questions", {
                    ...draft,
                    requestId: questionRequestId,
                  });
                  setQuestionRequestId(crypto.randomUUID());
                  setDraft(initialDraft);
                  await refresh();
                  setModal("");
                  toast.success(
                    draft.realtime
                      ? "실시간 질문을 등록했어요. 현장 답변자를 찾고 있어요!"
                      : "질문을 등록했어요.",
                  );
                });
              }}
            >
              <label>
                질문 제목
                <input
                  required
                  maxLength={140}
                  placeholder="지금 궁금한 것을 한 문장으로 적어주세요"
                  value={draft.title}
                  onChange={(e) =>
                    setDraft({ ...draft, title: e.target.value })
                  }
                />
              </label>
              <label>
                자세한 상황
                <textarea
                  required
                  maxLength={3000}
                  rows={3}
                  placeholder="답변에 필요한 상황을 알려주세요"
                  value={draft.body}
                  onChange={(e) => setDraft({ ...draft, body: e.target.value })}
                />
              </label>
              <div className="form-row">
                <label>
                  주제 분류
                  <select
                    value={draft.category}
                    onChange={(e) =>
                      setDraft({ ...draft, category: e.target.value })
                    }
                  >
                    <option value="">자동 분류</option>
                    {categories.map((c) => (
                      <option key={c}>{c}</option>
                    ))}
                  </select>
                </label>
                <label>
                  관련 학과
                  <select
                    value={draft.department}
                    onChange={(e) =>
                      setDraft({ ...draft, department: e.target.value })
                    }
                  >
                    <option>전체 학과</option>
                    {departments.map((d) => (
                      <option key={d}>{d}</option>
                    ))}
                  </select>
                </label>
                <label>
                  장소
                  <input
                    list="campus-locations"
                    maxLength={80}
                    placeholder="검색하거나 선택하세요"
                    value={draft.location}
                    onChange={(e) =>
                      setDraft({ ...draft, location: e.target.value })
                    }
                  />
                  <datalist id="campus-locations">
                    {campusLocations.map((l) => (
                      <option key={l} value={l} />
                    ))}
                  </datalist>
                </label>
              </div>
              <label>
                어떤 사람이 답해주면 좋을까요?
                <span className="input-with-action">
                  <input
                    maxLength={300}
                    placeholder="예: 지금 학생회관에 있는 사람"
                    value={draft.targetHint}
                    onChange={(e) =>
                      setDraft({ ...draft, targetHint: e.target.value })
                    }
                  />
                  <button
                    type="button"
                    className="field-action"
                    disabled={!draft.location}
                    title={
                      draft.location
                        ? `지금 ${draft.location}에 있는 사람`
                        : "장소를 먼저 선택하세요"
                    }
                    onClick={() =>
                      setDraft({
                        ...draft,
                        targetHint: `지금 ${draft.location}에 있는 사람`,
                      })
                    }
                  >
                    장소와 동일
                  </button>
                </span>
              </label>
              <label
                className={"realtime-toggle" + (draft.realtime ? " on" : "")}
              >
                <input
                  type="checkbox"
                  checked={draft.realtime}
                  onChange={(e) =>
                    setDraft({ ...draft, realtime: e.target.checked })
                  }
                />
                <span className="realtime-copy">
                  <b>
                    <Zap size={15} />
                    지금 상황에 대한 질문이에요
                  </b>
                  <small>
                    AI 과거 답변을 쓰지 않고 현장에 있는 사람에게 바로 전달해요.
                  </small>
                </span>
              </label>
              <button className="primary" disabled={busy}>
                <Send size={17} />
                {busy ? "분석하고 연결하는 중…" : "질문 등록하기"}
              </button>
            </form>
          )}
          {modal === "detail" && selected && (
            <div className="detail">
              <div className="detail-meta">
                {selected.authorName} · {selected.department} ·{" "}
                {ago(selected.createdAt)}
              </div>
              <p className="question-body">{selected.body}</p>
              {selected.targetHint && (
                <p className="target-hint">답변 희망: {selected.targetHint}</p>
              )}
              {selected.realtime ? (
                <div className="notice">
                  <Zap size={17} />
                  실시간 질문이에요.
                </div>
              ) : (
                selected.aiAnswer && (
                  <div className="ai-answer">
                    <b>이전 답변을 참고한 AI 답변</b>
                    <p>{selected.aiAnswer}</p>
                    {(selected.sources || []).map((id) => (
                      <button
                        key={id}
                        onClick={() => {
                          const q = data.questions.find((q) => q.id === id);
                          if (q) void openQuestion(q);
                          else
                            void api("questions/" + encodeURIComponent(id))
                              .then((d) => openQuestion(d.question))
                              .catch((e) => toast.error(e.message));
                        }}
                      >
                        참고 질문 보기 ↗
                      </button>
                    ))}
                  </div>
                )
              )}
              <h3>답변 {answers.length}</h3>
              {answers.map((a) => (
                <article className="answer" key={a.id}>
                  <b>
                    {a.name}
                    <span className="tag normal-tag">
                      {a.role === "senior" ? "선배" : "새내기"}
                    </span>
                  </b>
                  <p>{a.body}</p>
                  <small>{ago(a.createdAt)}</small>
                </article>
              ))}
              {selected.status === "closed" ? (
                <div className="notice">해결된 질문이에요.</div>
              ) : (
                <>
                  <div className="quick-actions">
                    {selected.answerType === "yes_no" &&
                      ["네", "아니요"].map((t) => (
                        <button
                          disabled={busy}
                          key={t}
                          onClick={() => void submitAnswer(t)}
                        >
                          {t}
                        </button>
                      ))}
                  </div>
                  <form
                    className="form"
                    onSubmit={(e) => {
                      e.preventDefault();
                      void submitAnswer(answer);
                    }}
                  >
                    <textarea
                      aria-label="답변 내용"
                      required
                      maxLength={2000}
                      placeholder="알고 있는 내용을 나눠주세요"
                      value={answer}
                      onChange={(e) => setAnswer(e.target.value)}
                    />
                    <button
                      className="primary"
                      disabled={busy || !answer.trim()}
                    >
                      답변 남기기
                    </button>
                  </form>
                  {selected.authorId === p?.id && (
                    <button
                      className="text-button"
                      disabled={busy}
                      onClick={() =>
                        void run(async () => {
                          await api("resolve", { questionId: selected.id });
                          await refresh();
                          setModal("");
                          toast.success("해결한 질문으로 표시했어요.");
                        })
                      }
                    >
                      질문 해결 완료
                    </button>
                  )}
                </>
              )}
            </div>
          )}
          {modal === "notifications" && (
            <div className="request-list">
              {data.requests.length ? (
                data.requests.map((r) => (
                  <button
                    key={r.requestId}
                    onClick={() => {
                      void api("seen", { requestId: r.requestId });
                      void openQuestion(r);
                    }}
                  >
                    <span className="tag urgent-tag">답변 요청</span>
                    <h3>{r.title}</h3>
                    <p>{r.reason}</p>
                    <small>
                      {new Date(r.expiresAt).toLocaleTimeString("ko-KR")}까지 ·
                      답변 +10P
                    </small>
                  </button>
                ))
              ) : (
                <div className="empty">아직 답변 요청이 없어요.</div>
              )}
            </div>
          )}
          {modal === "points" && (
            <div className="ledger">
              <div className="points">
                {p?.points ?? 0}
                <small>P</small>
              </div>
              {data.ledger.map((l) => (
                <div key={l.id}>
                  <span>{l.reason}</span>
                  <b className={l.delta > 0 ? "positive" : "negative"}>
                    {l.delta > 0 ? "+" : ""}
                    {l.delta}P
                  </b>
                </div>
              ))}
              {!data.ledger.length && <p>아직 포인트 변동이 없어요.</p>}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
