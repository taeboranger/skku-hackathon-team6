import { setting } from "./server.js";

export type Coordinates = {
  lat: number;
  lng: number;
};

// 성균관대학교 자연과학캠퍼스 (수원) 기준 좌표
export const SKKU_SUWON_CENTER: Coordinates = {
  lat: 37.2942,
  lng: 126.9745,
};

// 성균관대 자과캠 주요 POI 좌표 맵 (Fallback 및 빠른 조회용)
const POI_MAP: { keywords: string[]; coords: Coordinates }[] = [
  {
    keywords: ["학생회관", "학회", "학생 식당", "학식"],
    coords: { lat: 37.294, lng: 126.975 },
  },
  {
    keywords: ["삼성학술정보관", "학술정보관", "도서관", "중도"],
    coords: { lat: 37.2936, lng: 126.9743 },
  },
  {
    keywords: ["제1공학관", "1공학관", "1공"],
    coords: { lat: 37.2952, lng: 126.976 },
  },
  {
    keywords: ["제2공학관", "2공학관", "2공"],
    coords: { lat: 37.2958, lng: 126.9752 },
  },
  {
    keywords: ["복지회관", "복지관"],
    coords: { lat: 37.2931, lng: 126.9748 },
  },
  {
    keywords: ["기숙사", "신관", "지관", "인관", "의관", "예관", "봉룡학사"],
    coords: { lat: 37.2965, lng: 126.9735 },
  },
  {
    keywords: ["의학관", "약학관", "생명공학관"],
    coords: { lat: 37.2925, lng: 126.973 },
  },
  {
    keywords: ["자연과학관", "기초학문관"],
    coords: { lat: 37.2948, lng: 126.9738 },
  },
  {
    keywords: ["수성관", "체육관"],
    coords: { lat: 37.2918, lng: 126.9755 },
  },
  {
    keywords: ["정문", "쪽문", "셔틀"],
    coords: { lat: 37.293, lng: 126.9765 },
  },
];

export function findSKKUPoiCoordinates(text: string): Coordinates | null {
  if (!text) return null;
  const target = text.toLowerCase().replace(/\s+/g, "");
  for (const item of POI_MAP) {
    if (item.keywords.some((kw) => target.includes(kw.replace(/\s+/g, "")))) {
      return item.coords;
    }
  }
  return null;
}

export async function resolveLocationCoordinates(
  locationName: string,
  fullText: string = "",
): Promise<Coordinates> {
  const query = (locationName || fullText).trim();
  if (!query) return SKKU_SUWON_CENTER;

  // 1. 네이버 지도 Geocoding API / Search API 시도
  const clientId =
    setting("NAVER_CLIENT_ID") || setting("NAVER_MAPS_CLIENT_ID");
  const clientSecret =
    setting("NAVER_CLIENT_SECRET") || setting("NAVER_MAPS_CLIENT_SECRET");

  if (clientId && clientSecret) {
    try {
      const fullSearchQuery = query.includes("성균관")
        ? query
        : `성균관대학교 자연과학캠퍼스 ${query}`;
      
      // Naver Maps Geocoding API
      const geoUrl = `https://naveropenapi.apigw.ntruss.com/map-geocode/v2/geocode?query=${encodeURIComponent(
        fullSearchQuery,
      )}`;
      const res = await fetch(geoUrl, {
        headers: {
          "X-NCP-APIGW-API-KEY-ID": clientId,
          "X-NCP-APIGW-API-KEY": clientSecret,
        },
      });

      if (res.ok) {
        const data: any = await res.json();
        if (data.addresses && data.addresses.length > 0) {
          const first = data.addresses[0];
          const lat = parseFloat(first.y);
          const lng = parseFloat(first.x);
          if (!isNaN(lat) && !isNaN(lng)) {
            return { lat, lng };
          }
        }
      }
    } catch {
      // API 실패 시 Fallback으로 진행
    }
  }

  // 2. 성균관대 자과캠 POI 매칭 Fallback
  const poiMatch = findSKKUPoiCoordinates(locationName) || findSKKUPoiCoordinates(fullText);
  if (poiMatch) {
    return poiMatch;
  }

  // 3. 기본 성균관대 자과캠 중앙 좌표
  return SKKU_SUWON_CENTER;
}
