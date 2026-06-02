import axios from "axios";
import type { Coordinates, Place } from "../types";
import { getOpenStateNow } from "../utils/openHours";
import { haversineDistance, calcWalkingMinutes } from "../utils/geo";
import { logger } from "../utils/logger";

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

function contentTypeLabel(contentTypeId: string): string {
  if (contentTypeId === CONTENT_TYPE.tourist) return "관광지/공원";
  if (contentTypeId === CONTENT_TYPE.culture) return "문화시설/전시";
  if (contentTypeId === CONTENT_TYPE.festival) return "축제/행사";
  return "알 수 없음";
}

function summarizeTourItem(item: TourItem): string {
  const eventPeriod = item.eventstartdate || item.eventenddate
    ? ` period=${item.eventstartdate ?? "?"}~${item.eventenddate ?? "?"}`
    : "";
  return `${item.title} | id=${item.contentid} addr=${item.addr1 || "-"} dist=${item.dist || "-"}m${eventPeriod}`;
}

function summarizePlace(place: Place): string {
  return `${place.name} → category=${place.category} minutes=${place.walkingMinutes} address=${place.address || "-"}`;
}

function summarizeErrorData(data: unknown): string {
  if (data === undefined || data === null) return "-";
  const text = typeof data === "string" ? data : JSON.stringify(data);
  return text.length > 500 ? `${text.slice(0, 500)}...` : text;
}

async function fetchLocationBased(
  coords: Coordinates,
  contentTypeId: string,
  radius = 2000,
  numOfRows = 10
): Promise<TourItem[]> {
  if (!API_KEY) return [];

  try {
    logger.info("tourApi", "locationBasedList1 요청", {
      contentTypeId,
      type: contentTypeLabel(contentTypeId),
      radius,
      numOfRows,
      lat: coords.lat,
      lng: coords.lng,
    });

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

    const header = data?.response?.header;
    const body = data?.response?.body;
    const items = data?.response?.body?.items?.item;
    const normalized = !items ? [] : Array.isArray(items) ? items : [items];

    logger.info("tourApi", "locationBasedList1 응답", {
      contentTypeId,
      type: contentTypeLabel(contentTypeId),
      resultCode: header?.resultCode ?? "-",
      resultMsg: header?.resultMsg ?? "-",
      totalCount: body?.totalCount ?? 0,
      itemCount: normalized.length,
    });

    if (normalized.length > 0) {
      logger.block(
        "tourApi",
        `원본 응답 샘플 contentTypeId=${contentTypeId}`,
        normalized.slice(0, 5).map(summarizeTourItem)
      );
    }

    if (!items) {
      logger.info("tourApi", "응답 비어있음", { contentTypeId, type: contentTypeLabel(contentTypeId) });
      return [];
    }
    return normalized;
  } catch (err: unknown) {
    const response = (err as { response?: { status?: number; data?: unknown } })?.response;
    logger.error("tourApi", "locationBasedList1 오류", {
      contentTypeId,
      type: contentTypeLabel(contentTypeId),
      status: response?.status ?? "unknown",
      body: summarizeErrorData(response?.data),
    });
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
  if (cached && Date.now() < cached.expiresAt) {
    logger.info("tourApi", "관광지 캐시 HIT", { key, applied: cached.data.length });
    return cached.data;
  }

  try {
    const items = await fetchLocationBased(coords, CONTENT_TYPE.tourist, 3000, 14);
    const excluded = items.filter((item) =>
      ATTRACTION_EXCLUDE_KW.some((kw) => item.title.includes(kw))
    );
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
    logger.info("tourApi", "관광지 적용 결과", {
      raw: items.length,
      excluded: excluded.length,
      applied: result.length,
    });
    if (excluded.length > 0) {
      logger.list("tourApi", "관광지 제외", excluded.map((item) => `${item.title}(키즈/어린이 계열)`), 10);
    }
    if (result.length > 0) {
      logger.block("tourApi", "관광지 최종 반영", result.slice(0, 8).map(summarizePlace));
    }
    attractionCache.set(key, { data: result, expiresAt: Date.now() + CACHE_TTL });
    return result;
  } catch (err) {
    logger.error("tourApi", "관광지 조회 오류", { error: err instanceof Error ? err.message : String(err) });
    return [];
  }
}

// ── 문화시설 / 전시 (contentType 14) ────────────────────────────
export async function getTourCulture(coords: Coordinates): Promise<Place[]> {
  const key = cacheKey(coords);
  const cached = cultureCache.get(key);
  if (cached && Date.now() < cached.expiresAt) {
    logger.info("tourApi", "문화시설 캐시 HIT", { key, applied: cached.data.length });
    return cached.data;
  }

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
    logger.info("tourApi", "문화시설 적용 결과", {
      raw: items.length,
      applied: result.length,
    });
    if (result.length > 0) {
      logger.block("tourApi", "문화시설 최종 반영", result.slice(0, 8).map(summarizePlace));
    }
    cultureCache.set(key, { data: result, expiresAt: Date.now() + CACHE_TTL });
    return result;
  } catch (err) {
    logger.error("tourApi", "문화시설 조회 오류", { error: err instanceof Error ? err.message : String(err) });
    return [];
  }
}

// ── 축제/행사/팝업 (contentType 15) ─────────────────────────────
export async function getTourFestivals(coords: Coordinates): Promise<Place[]> {
  const key = cacheKey(coords);
  const cached = festivalCache.get(key);
  if (cached && Date.now() < cached.expiresAt) {
    logger.info("tourApi", "행사 캐시 HIT", { key, applied: cached.data.length });
    return cached.data;
  }

  try {
    const items = await fetchFestivals(coords, 5000);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    let keywordExcluded = 0;
    let expiredExcluded = 0;

    const result = items
      .map((item) => {
        const searchableText = `${item.title ?? ""} ${item.addr1 ?? ""}`.toLowerCase();
        if (EVENT_EXCLUDE_TEXT_KW.some((kw) => searchableText.includes(kw.toLowerCase()))) {
          keywordExcluded += 1;
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
          if (endDate < today) {
            expiredExcluded += 1;
            return null;
          }
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

    logger.info("tourApi", "행사 적용 결과", {
      raw: items.length,
      keywordExcluded,
      expiredExcluded,
      applied: result.length,
    });
    if (result.length > 0) {
      logger.block("tourApi", "행사 최종 반영", result.slice(0, 8).map(summarizePlace));
    }
    festivalCache.set(key, { data: result, expiresAt: Date.now() + CACHE_TTL });
    return result;
  } catch (err) {
    logger.error("tourApi", "행사 조회 오류", { error: err instanceof Error ? err.message : String(err) });
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
