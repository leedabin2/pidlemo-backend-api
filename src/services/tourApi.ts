import axios from "axios";
import type { Coordinates, Place } from "../types";
import { getOpenStateNow } from "../utils/openHours";

const API_KEY = process.env.TOUR_API_KEY ?? "";
const BASE_URL = "https://apis.data.go.kr/B551011/KorService1";

// 24시간 캐시
interface CacheEntry<T> { data: T; expiresAt: number }
const attractionCache = new Map<string, CacheEntry<Place[]>>();
const cultureCache = new Map<string, CacheEntry<Place[]>>();
const festivalCache = new Map<string, CacheEntry<Place[]>>();
const CACHE_TTL = 24 * 60 * 60 * 1000;

function cacheKey(coords: Coordinates): string {
  return `${coords.lat.toFixed(2)}_${coords.lng.toFixed(2)}`;
}

// 두 좌표 사이 직선거리 (미터)
function haversineDistance(a: Coordinates, b: Coordinates): number {
  const R = 6371000;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const aa =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((a.lat * Math.PI) / 180) *
      Math.cos((b.lat * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(aa), Math.sqrt(1 - aa));
}

function calcWalkingMinutes(meters: number): number {
  return Math.round(meters / 80);
}

// contentTypeId
// 12: 관광지 (공원, 자연경관)
// 14: 문화시설 (미술관, 전시관)
// 15: 축제/공연/행사 (팝업, 행사)
const CONTENT_TYPE = {
  tourist: "12",
  culture: "14",
  festival: "15",
} as const;

const EVENT_EXCLUDE_TEXT_KW = [
  "유흥", "유흥주점", "단란주점", "주점", "라이브주점", "라이브바",
  "클럽", "라운지", "룸", "룸살롱", "헌팅", "포차", "호프", "이자카야",
];

// TourAPI 관광지(12) 중 키즈 시설 제외
const ATTRACTION_EXCLUDE_KW = ["키즈", "어린이", "유아", "놀이방", "키즈카페", "유아카페", "어린이집", "유치원"];

interface TourItem {
  contentid: string;
  title: string;
  addr1: string;
  mapx: string; // lng
  mapy: string; // lat
  dist: string; // 미터
  contenttypeid: string;
  eventstartdate?: string;
  eventenddate?: string;
  firstimage?: string;
}

async function fetchLocationBased(
  coords: Coordinates,
  contentTypeId: string,
  radius = 2000,
  numOfRows = 10
): Promise<TourItem[]> {
  if (!API_KEY) return [];

  try {
    const { data } = await axios.get(`${BASE_URL}/locationBasedList1`, {
      params: {
        serviceKey: API_KEY,
        numOfRows,
        pageNo: 1,
        MobileOS: "ETC",
        MobileApp: "pidlemo",
        _type: "json",
        mapX: coords.lng,
        mapY: coords.lat,
        radius,
        contentTypeId,
        arrange: "E",
      },
    });

    const items = data?.response?.body?.items?.item;
    if (!items) {
      console.warn(`[tourApi] contentType=${contentTypeId} 응답 비어있음`);
      return [];
    }
    return Array.isArray(items) ? items : [items];
  } catch (err: unknown) {
    const status = (err as { response?: { status?: number } })?.response?.status;
    console.error(`[tourApi] locationBasedList1 contentType=${contentTypeId} 오류 (status:${status ?? "unknown"})`);
    return [];
  }
}

async function fetchFestivals(
  coords: Coordinates,
  radius = 5000
): Promise<TourItem[]> {
  // searchFestival1은 위치 기반 필터를 지원하지 않아 500 에러 발생
  // locationBasedList1 (contentTypeId=15)으로 대체
  return fetchLocationBased(coords, CONTENT_TYPE.festival, radius, 20);
}

// 행사 마감 태그 생성
function getEventTags(endDate?: string): string[] {
  if (!endDate) return [];
  const end = new Date(
    endDate.replace(/(\d{4})(\d{2})(\d{2})/, "$1-$2-$3")
  );
  const now = new Date();
  const daysLeft = Math.ceil(
    (end.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)
  );
  if (daysLeft < 0) return [];
  if (daysLeft === 0) return ["오늘 마감"];
  if (daysLeft <= 3) return [`${daysLeft}일 남음`];
  return ["진행중"];
}

// ── 공원 / 관광지 (contentType 12) ──────────────────────────────
export async function getTourAttractions(coords: Coordinates): Promise<Place[]> {
  const key = cacheKey(coords);
  const cached = attractionCache.get(key);
  if (cached && Date.now() < cached.expiresAt) return cached.data;

  try {
    const items = await fetchLocationBased(coords, CONTENT_TYPE.tourist, 3000, 14);
    const result = items.filter((item) =>
      !ATTRACTION_EXCLUDE_KW.some((kw) => item.title.includes(kw))
    ).map((item) => {
      const placeCoords = {
        lat: parseFloat(item.mapy),
        lng: parseFloat(item.mapx),
      };
      const dist = item.dist
        ? parseInt(item.dist, 10)
        : haversineDistance(coords, placeCoords);
      return {
        id: `tour-attraction-${item.contentid}`,
        name: item.title,
        category: "park" as const,
        coordinates: placeCoords,
        address: item.addr1,
        walkingMinutes: calcWalkingMinutes(dist),
        operatingHours: "상시",
        isOpen: getOpenStateNow("상시"),
        tags: ["관광지"],
        source: "public_data" as const,
      };
    });
    attractionCache.set(key, { data: result, expiresAt: Date.now() + CACHE_TTL });
    return result;
  } catch (err) {
    console.error("[tourApi] 관광지 조회 오류:", err);
    return [];
  }
}

// ── 문화시설 / 전시 (contentType 14) ────────────────────────────
export async function getTourCulture(coords: Coordinates): Promise<Place[]> {
  const key = cacheKey(coords);
  const cached = cultureCache.get(key);
  if (cached && Date.now() < cached.expiresAt) return cached.data;

  try {
    const items = await fetchLocationBased(coords, CONTENT_TYPE.culture, 3000, 14);
    const result = items.map((item) => {
      const placeCoords = {
        lat: parseFloat(item.mapy),
        lng: parseFloat(item.mapx),
      };
      const dist = item.dist
        ? parseInt(item.dist, 10)
        : haversineDistance(coords, placeCoords);
      return {
        id: `tour-culture-${item.contentid}`,
        name: item.title,
        category: "exhibition" as const,
        coordinates: placeCoords,
        address: item.addr1,
        walkingMinutes: calcWalkingMinutes(dist),
        operatingHours: "운영시간 확인 필요",
        isOpen: getOpenStateNow("운영시간 확인 필요"),
        tags: ["문화시설"],
        source: "public_data" as const,
      };
    });
    cultureCache.set(key, { data: result, expiresAt: Date.now() + CACHE_TTL });
    return result;
  } catch (err) {
    console.error("[tourApi] 문화시설 조회 오류:", err);
    return [];
  }
}

// ── 축제/행사/팝업 (contentType 15) ─────────────────────────────
export async function getTourFestivals(coords: Coordinates): Promise<Place[]> {
  const key = cacheKey(coords);
  const cached = festivalCache.get(key);
  if (cached && Date.now() < cached.expiresAt) return cached.data;

  try {
    const items = await fetchFestivals(coords, 5000);
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const result = items
      .map((item) => {
        const searchableText = `${item.title ?? ""} ${item.addr1 ?? ""}`.toLowerCase();
        if (EVENT_EXCLUDE_TEXT_KW.some((kw) => searchableText.includes(kw.toLowerCase()))) {
          return null;
        }

        const placeCoords = {
          lat: parseFloat(item.mapy),
          lng: parseFloat(item.mapx),
        };
        const dist = item.dist
          ? parseInt(item.dist, 10)
          : haversineDistance(coords, placeCoords);

        // 종료일이 오늘 이전이면 제외
        if (item.eventenddate) {
          const endStr = item.eventenddate.replace(/(\d{4})(\d{2})(\d{2})/, "$1-$2-$3");
          const endDate = new Date(endStr);
          endDate.setHours(23, 59, 59);
          if (endDate < today) return null;
        }

        const tags = getEventTags(item.eventenddate);

        const opStart = item.eventstartdate
          ? `${item.eventstartdate.slice(0,4)}.${item.eventstartdate.slice(4,6)}.${item.eventstartdate.slice(6)}`
          : "";
        const opEnd = item.eventenddate
          ? `${item.eventenddate.slice(0,4)}.${item.eventenddate.slice(4,6)}.${item.eventenddate.slice(6)}`
          : "";
        const operatingHours = opStart && opEnd ? `${opStart} ~ ${opEnd}` : "기간 확인 필요";

        return {
          id: `tour-festival-${item.contentid}`,
          name: item.title,
          category: "popup" as const,
          coordinates: placeCoords,
          address: item.addr1,
          walkingMinutes: calcWalkingMinutes(dist),
          operatingHours,
          isOpen: getOpenStateNow(operatingHours),
          tags,
          source: "public_data" as const,
        };
      })
      .filter((p): p is NonNullable<typeof p> => p !== null) as Place[];

    festivalCache.set(key, { data: result, expiresAt: Date.now() + CACHE_TTL });
    return result;
  } catch (err) {
    console.error("[tourApi] 행사 조회 오류:", err);
    return [];
  }
}

// ── 목업 (API 키 없을 때) ────────────────────────────────────────
export function getMockAttractions(coords: Coordinates): Place[] {
  return [
    {
      id: "mock-park-1",
      name: "망원한강공원",
      category: "park",
      coordinates: { lat: coords.lat + 0.006, lng: coords.lng - 0.002 },
      address: "서울 마포구 망원동 한강",
      walkingMinutes: 18,
      operatingHours: "24시간",
      isOpen: getOpenStateNow("24시간"),
      tags: ["야외"],
      source: "public_data",
    },
  ];
}

export function getMockFestivals(coords: Coordinates): Place[] {
  return [
    {
      id: "mock-popup-1",
      name: "어반플레이 팝업",
      category: "popup",
      coordinates: { lat: coords.lat + 0.004, lng: coords.lng + 0.003 },
      address: "서울 마포구 망원동",
      walkingMinutes: 12,
      operatingHours: "11:00-20:00",
      isOpen: getOpenStateNow("11:00-20:00"),
      tags: ["오늘 마감"],
      source: "public_data",
    },
    {
      id: "mock-festival-2",
      name: "한강 봄꽃 축제",
      category: "popup",
      coordinates: { lat: coords.lat - 0.002, lng: coords.lng + 0.004 },
      address: "서울 마포구 서교동",
      walkingMinutes: 18,
      operatingHours: "10:00-21:00",
      isOpen: getOpenStateNow("10:00-21:00"),
      tags: ["3일 남음"],
      source: "public_data",
    },
  ];
}
