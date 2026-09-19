export type Profile = {
  id: string;
  authId: string;
  name: string;
  role: "freshman" | "senior";
  department: string;
  studentId: string;
  points: number;
  location: string;
  locationAt: number;
  lat?: number | null;
  lng?: number | null;
};
export type Analysis = {
  realtime: boolean;
  answerType: "yes_no" | "short" | "text";
  department: string;
  location: string;
  tags: string[];
  lat?: number | null;
  lng?: number | null;
};
export const reach = (points: number) =>
  Math.min(20, 3 + Math.floor(Math.max(0, points) / 30));
export const realTimePattern =
  /(지금|현재|실시간|오늘.*(자리|대기|줄|혼잡|열|닫|메뉴)|자리.*(있|없)|몇.*대기|방금)/;
export function tokens(s: string) {
  return [...new Set(s.toLowerCase().match(/[가-힣a-z0-9]{2,}/g) || [])];
}
export function similarity(a: string, b: string) {
  const grams = (s: string) => {
    const t = s.toLowerCase().replace(/\s/g, "");
    const out = new Set<string>();
    for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2));
    return out;
  };
  const x = grams(a),
    y = grams(b);
  if (!x.size || !y.size) return 0;
  let n = 0;
  for (const t of x) if (y.has(t)) n++;
  return (2 * n) / (x.size + y.size);
}
export function haversineDistance(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
): number {
  const R = 6371000;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) *
      Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}
export function rankCandidate(
  a: Analysis,
  p: Profile,
  history: { title: string; body: string }[],
  question: string,
  stats: { sent: number; answered: number; today: number; lastSent: number },
  now = Date.now(),
) {
  const reasons: string[] = [];
  let match = 0;
  if (a.department !== "전체 학과" && a.department === p.department) {
    match += 0.5;
    reasons.push("관련 학과의 구성원이에요");
  }
  if (
    a.lat != null &&
    a.lng != null &&
    p.lat != null &&
    p.lng != null &&
    now - p.locationAt <= 30 * 60 * 1000
  ) {
    const dist = haversineDistance(a.lat, a.lng, p.lat, p.lng);
    if (dist <= 1000) {
      const scoreBonus = Math.max(0.35, 0.85 - (dist / 1000) * 0.45);
      match += scoreBonus;
      const meters = Math.round(dist);
      reasons.push(
        meters < 50
          ? "질문 장소 바로 근처에 있어요"
          : `질문 장소에서 약 ${meters}m 거리에 있어요`,
      );
    }
  } else if (
    a.location &&
    p.location &&
    now - p.locationAt <= 30 * 60 * 1000 &&
    (a.location.includes(p.location) || p.location.includes(a.location))
  ) {
    match += 0.65;
    reasons.push("최근 공유한 위치가 질문 장소와 가까워요");
  }
  if (
    history.some((h) => similarity(question, h.title + " " + h.body) >= 0.35)
  ) {
    match += 0.6;
    reasons.push("유사한 질문의 답변을 받은 경험이 있어요");
  }
  const rate = (stats.answered + 2) / (stats.sent + 4);
  const score = Math.min(1, match) * 0.75 + rate * 0.25;
  const eligible =
    match > 0 &&
    stats.today < (p.role === "senior" ? 20 : 100) &&
    (p.role !== "senior" ||
      (score >= 0.65 && rate >= 0.5 && now - stats.lastSent > 4 * 3600000));
  return {
    id: p.id,
    score,
    eligible,
    reason: reasons.join(" · "),
    role: p.role,
  };
}

