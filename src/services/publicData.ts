import axios from "axios";
import type { Coordinates, Place } from "../types";
import { getOpenStateNow } from "../utils/openHours";
import { haversineDistance, calcWalkingMinutes } from "../utils/geo";
import { logger } from "../utils/logger";

const API_KEY = process.env.PUBLIC_DATA_API_KEY ?? "";

const SEOUL_CULTURE_URL =
  "http://openAPI.seoul.go.kr:8088/{API_KEY}/json/culturalEventInfo/1/100/";

const SEOUL_PARK_URL =
  "http://openAPI.seoul.go.kr:8088/{API_KEY}/json/SearchParkInfoService/1/30/";

interface CacheEntry<T> { data: T; expiresAt: number }
const eventCache = new Map<string, CacheEntry<Place[]>>();
const parkCache = new Map<string, CacheEntry<Place[]>>();
const CACHE_TTL = 24 * 60 * 60 * 1000;

function cacheKey(coords: Coordinates): string {
  return `${coords.lat.toFixed(2)}_${coords.lng.toFixed(2)}`;
}

function summarizeErrorData(data: unknown): string {
  if (data === undefined || data === null) return "-";
  const text = typeof data === "string" ? data : JSON.stringify(data);
  return text.length > 500 ? `${text.slice(0, 500)}...` : text;
}

function summarizeSeoulEvent(item: Record<string, string>): string {
  return `${item.TITLE ?? "-"} | code=${item.CULTCODE ?? "-"} place=${item.PLACE ?? "-"} period=${item.STRTDATE ?? "?"}~${item.END_DATE ?? "?"} lat=${item.LAT ?? "-"} lng=${item.LOT ?? "-"}`;
}

function summarizeSeoulPark(item: Record<string, string>): string {
  return `${item.PARK_NM ?? "-"} | id=${item.P_IDX ?? "-"} addr=${item.ADDR ?? "-"} lat=${item.LATITUDE ?? "-"} lng=${item.LONGITUDE ?? "-"}`;
}

function summarizePlace(place: Place): string {
  return `${place.name} → category=${place.category} minutes=${place.walkingMinutes} address=${place.address || "-"}`;
}

function isTodayInRange(startDate: string, endDate: string): boolean {
  const now = new Date();
  const start = new Date(startDate.replace(/\./g, "-"));
  const end = new Date(endDate.replace(/\./g, "-"));
  end.setHours(23, 59, 59); // 종료일 당일 포함
  return now >= start && now <= end;
}

export async function getNearByPopups(coords: Coordinates): Promise<Place[]> {
  if (!API_KEY) {
    logger.info("publicData", "서울 문화행사 API 키 없음 → mock 사용");
    return getMockPopups(coords);
  }

  const key = cacheKey(coords);
  const cached = eventCache.get(key);
  if (cached && Date.now() < cached.expiresAt) {
    logger.info("publicData", "서울 문화행사 캐시 HIT", { key, applied: cached.data.length });
    return cached.data;
  }

  try {
    logger.info("publicData", "서울 문화행사 요청", {
      endpoint: "culturalEventInfo",
      rows: 100,
      lat: coords.lat,
      lng: coords.lng,
    });

    const url = SEOUL_CULTURE_URL.replace("{API_KEY}", API_KEY);
    const { data } = await axios.get(url);
    const items = data?.culturalEventInfo?.row ?? [];
    const resultInfo = data?.culturalEventInfo?.RESULT;

    logger.info("publicData", "서울 문화행사 응답", {
      code: resultInfo?.CODE ?? "-",
      message: resultInfo?.MESSAGE ?? "-",
      totalCount: data?.culturalEventInfo?.list_total_count ?? items.length,
      itemCount: items.length,
    });

    if (items.length > 0) {
      logger.block(
        "publicData",
        "서울 문화행사 원본 샘플",
        items.slice(0, 5).map((item: Record<string, string>) => summarizeSeoulEvent(item))
      );
    }

    let inactiveExcluded = 0;
    let invalidCoordExcluded = 0;
    let distanceExcluded = 0;

    const candidates: Place[] = [];
    items.forEach((item: Record<string, string>, i: number) => {
      if (!isTodayInRange(item.STRTDATE, item.END_DATE)) {
        inactiveExcluded += 1;
        return;
      }

      const placeLat = parseFloat(item.LAT);
      const placeLng = parseFloat(item.LOT);
      if (!placeLat || !placeLng) {
        invalidCoordExcluded += 1;
        return;
      }

      const placeCoords = { lat: placeLat, lng: placeLng };
      const dist = haversineDistance(coords, placeCoords);
      const walkingMinutes = calcWalkingMinutes(dist);
      if (walkingMinutes > 60) {
        distanceExcluded += 1;
        return;
      }

      const today = new Date();
      const endDate = new Date(item.END_DATE.replace(/\./g, "-"));
      const daysLeft = Math.ceil(
        (endDate.getTime() - today.getTime()) / (1000 * 60 * 60 * 24)
      );

      const tags: string[] = [];
      if (daysLeft === 0) tags.push("오늘 마감");
      else if (daysLeft <= 3) tags.push(`${daysLeft}일 남음`);
      else tags.push("현재 진행중");

      candidates.push({
        id: `popup-${item.CULTCODE ?? i}`,
        name: item.TITLE,
        category: "popup" as const,
        coordinates: placeCoords,
        address: item.PLACE ?? "",
        walkingMinutes,
        operatingHours: `${item.STRTDATE} ~ ${item.END_DATE}`,
        isOpen: getOpenStateNow(`${item.STRTDATE} ~ ${item.END_DATE}`),
        tags,
        source: "public_data" as const,
      });
    });

    const result = candidates
      .sort((a: Place, b: Place) => a.walkingMinutes - b.walkingMinutes)
      .slice(0, 8);

    logger.info("publicData", "서울 문화행사 적용 결과", {
      raw: items.length,
      inactiveExcluded,
      invalidCoordExcluded,
      distanceExcluded,
      applied: result.length,
    });
    if (result.length > 0) {
      logger.block("publicData", "서울 문화행사 최종 반영", result.slice(0, 8).map(summarizePlace));
    }

    eventCache.set(key, { data: result, expiresAt: Date.now() + CACHE_TTL });
    return result;
  } catch (err) {
    const response = (err as { response?: { status?: number; data?: unknown } })?.response;
    logger.error("publicData", "서울 문화행사 API 오류", {
      status: response?.status ?? "unknown",
      body: summarizeErrorData(response?.data),
      error: err instanceof Error ? err.message : String(err),
    });
    return getMockPopups(coords);
  }
}

export async function getNearByParks(coords: Coordinates): Promise<Place[]> {
  if (!API_KEY) {
    logger.info("publicData", "서울 공원 API 키 없음 → mock 사용");
    return getMockParks(coords);
  }

  const key = cacheKey(coords);
  const cached = parkCache.get(key);
  if (cached && Date.now() < cached.expiresAt) {
    logger.info("publicData", "서울 공원 캐시 HIT", { key, applied: cached.data.length });
    return cached.data;
  }

  try {
    logger.info("publicData", "서울 공원 요청", {
      endpoint: "SearchParkInfoService",
      rows: 30,
      lat: coords.lat,
      lng: coords.lng,
    });

    const url = SEOUL_PARK_URL.replace("{API_KEY}", API_KEY);
    const { data } = await axios.get(url);
    const items = data?.SearchParkInfoService?.row ?? [];
    const resultInfo = data?.SearchParkInfoService?.RESULT;

    logger.info("publicData", "서울 공원 응답", {
      code: resultInfo?.CODE ?? "-",
      message: resultInfo?.MESSAGE ?? "-",
      totalCount: data?.SearchParkInfoService?.list_total_count ?? items.length,
      itemCount: items.length,
    });

    if (items.length > 0) {
      logger.block(
        "publicData",
        "서울 공원 원본 샘플",
        items.slice(0, 5).map((item: Record<string, string>) => summarizeSeoulPark(item))
      );
    }

    let invalidCoordExcluded = 0;
    let distanceExcluded = 0;

    const candidates: Place[] = [];
    items.forEach((item: Record<string, string>) => {
      const parkLat = parseFloat(item.LATITUDE) || 0;
      const parkLng = parseFloat(item.LONGITUDE) || 0;
      if (!parkLat || !parkLng) {
        invalidCoordExcluded += 1;
        return;
      }

      const placeCoords = { lat: parkLat, lng: parkLng };
      const dist = haversineDistance(coords, placeCoords);
      const walkingMinutes = calcWalkingMinutes(dist);
      if (walkingMinutes > 30) {
        distanceExcluded += 1;
        return;
      }

      candidates.push({
        id: `park-${item.P_IDX ?? item.PARK_NM}`,
        name: item.PARK_NM,
        category: "park" as const,
        coordinates: placeCoords,
        address: item.ADDR ?? "",
        walkingMinutes,
        operatingHours: "24시간",
        isOpen: getOpenStateNow("24시간"),
        tags: ["야외"],
        source: "public_data" as const,
      });
    });

    const result = candidates
      .sort((a: Place, b: Place) => a.walkingMinutes - b.walkingMinutes)
      .slice(0, 8);

    logger.info("publicData", "서울 공원 적용 결과", {
      raw: items.length,
      invalidCoordExcluded,
      distanceExcluded,
      applied: result.length,
    });
    if (result.length > 0) {
      logger.block("publicData", "서울 공원 최종 반영", result.slice(0, 8).map(summarizePlace));
    }

    parkCache.set(key, { data: result, expiresAt: Date.now() + CACHE_TTL });
    return result;
  } catch (err) {
    const response = (err as { response?: { status?: number; data?: unknown } })?.response;
    logger.error("publicData", "서울 공원 API 오류", {
      status: response?.status ?? "unknown",
      body: summarizeErrorData(response?.data),
      error: err instanceof Error ? err.message : String(err),
    });
    return getMockParks(coords);
  }
}

// ── 목업 (API 키 없을 때) ──────────────────────────────────────────
export function getMockPopups(coords: Coordinates): Place[] {
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
      id: "mock-popup-2",
      name: "현대카드 라이브러리 팝업",
      category: "exhibition",
      coordinates: { lat: coords.lat - 0.002, lng: coords.lng + 0.004 },
      address: "서울 마포구 서교동",
      walkingMinutes: 18,
      operatingHours: "12:00-21:00",
      isOpen: getOpenStateNow("12:00-21:00"),
      tags: ["3일 남음"],
      source: "public_data",
    },
  ];
}

export function getMockParks(coords: Coordinates): Place[] {
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
