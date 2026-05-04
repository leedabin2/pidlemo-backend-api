import axios from "axios";
import type { Coordinates, Place } from "../types";
import { getOpenStateNow } from "../utils/openHours";

const API_KEY = process.env.PUBLIC_DATA_API_KEY ?? "";

// 서울시 문화행사 정보 API (OA-15486)
// URL 형식: /{인증키}/json/culturalEventInfo/{시작번호}/{종료번호}/
const SEOUL_CULTURE_URL =
  "http://openAPI.seoul.go.kr:8088/{API_KEY}/json/culturalEventInfo/1/100/";

// 서울시 공원정보 API
const SEOUL_PARK_URL =
  "http://openAPI.seoul.go.kr:8088/{API_KEY}/json/SearchParkInfoService/1/30/";

// 24시간 캐시
interface CacheEntry<T> { data: T; expiresAt: number }
const eventCache = new Map<string, CacheEntry<Place[]>>();
const parkCache = new Map<string, CacheEntry<Place[]>>();
const CACHE_TTL = 24 * 60 * 60 * 1000;

function cacheKey(coords: Coordinates): string {
  return `${coords.lat.toFixed(2)}_${coords.lng.toFixed(2)}`;
}

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

function isTodayInRange(startDate: string, endDate: string): boolean {
  const now = new Date();
  const start = new Date(startDate.replace(/\./g, "-"));
  const end = new Date(endDate.replace(/\./g, "-"));
  end.setHours(23, 59, 59); // 종료일 당일 포함
  return now >= start && now <= end;
}

export async function getNearByPopups(coords: Coordinates): Promise<Place[]> {
  if (!API_KEY) return getMockPopups(coords);

  const key = cacheKey(coords);
  const cached = eventCache.get(key);
  if (cached && Date.now() < cached.expiresAt) return cached.data;

  try {
    const url = SEOUL_CULTURE_URL.replace("{API_KEY}", API_KEY);
    const { data } = await axios.get(url);
    const items = data?.culturalEventInfo?.row ?? [];

    const result: Place[] = items
      .filter((item: Record<string, string>) =>
        isTodayInRange(item.STRTDATE, item.END_DATE)
      )
      .map((item: Record<string, string>, i: number) => {
        const placeLat = parseFloat(item.LAT);
        const placeLng = parseFloat(item.LOT);
        if (!placeLat || !placeLng) return null;

        const placeCoords = { lat: placeLat, lng: placeLng };
        const dist = haversineDistance(coords, placeCoords);

        const today = new Date();
        const endDate = new Date(item.END_DATE.replace(/\./g, "-"));
        const daysLeft = Math.ceil(
          (endDate.getTime() - today.getTime()) / (1000 * 60 * 60 * 24)
        );

        const tags: string[] = [];
        if (daysLeft === 0) tags.push("오늘 마감");
        else if (daysLeft <= 3) tags.push(`${daysLeft}일 남음`);
        else tags.push("현재 진행중");

        return {
          id: `popup-${item.CULTCODE ?? i}`,
          name: item.TITLE,
          category: "popup" as const,
          coordinates: placeCoords,
          address: item.PLACE ?? "",
          walkingMinutes: calcWalkingMinutes(dist),
          operatingHours: `${item.STRTDATE} ~ ${item.END_DATE}`,
          isOpen: getOpenStateNow(`${item.STRTDATE} ~ ${item.END_DATE}`),
          tags,
          source: "public_data" as const,
        };
      })
      .filter((p: Place | null): p is Place => p !== null && calcWalkingMinutes(haversineDistance(coords, p.coordinates)) <= 60)
      .sort((a: Place, b: Place) => a.walkingMinutes - b.walkingMinutes)
      .slice(0, 8);

    eventCache.set(key, { data: result, expiresAt: Date.now() + CACHE_TTL });
    return result;
  } catch (err) {
    console.error("[publicData] 행사 API 오류:", err);
    return getMockPopups(coords);
  }
}

export async function getNearByParks(coords: Coordinates): Promise<Place[]> {
  if (!API_KEY) return getMockParks(coords);

  const key = cacheKey(coords);
  const cached = parkCache.get(key);
  if (cached && Date.now() < cached.expiresAt) return cached.data;

  try {
    const url = SEOUL_PARK_URL.replace("{API_KEY}", API_KEY);
    const { data } = await axios.get(url);
    const items = data?.SearchParkInfoService?.row ?? [];

    const result: Place[] = items
      .map((item: Record<string, string>) => {
        const parkLat = parseFloat(item.LATITUDE) || 0;
        const parkLng = parseFloat(item.LONGITUDE) || 0;
        if (!parkLat || !parkLng) return null;

        const placeCoords = { lat: parkLat, lng: parkLng };
        const dist = haversineDistance(coords, placeCoords);

        return {
          id: `park-${item.P_IDX ?? item.PARK_NM}`,
          name: item.PARK_NM,
          category: "park" as const,
          coordinates: placeCoords,
          address: item.ADDR ?? "",
          walkingMinutes: calcWalkingMinutes(dist),
          operatingHours: "24시간",
          isOpen: getOpenStateNow("24시간"),
          tags: ["야외"],
          source: "public_data" as const,
        };
      })
      .filter((p: Place | null): p is Place => p !== null && p.walkingMinutes <= 30)
      .sort((a: Place, b: Place) => a.walkingMinutes - b.walkingMinutes)
      .slice(0, 8);

    parkCache.set(key, { data: result, expiresAt: Date.now() + CACHE_TTL });
    return result;
  } catch (err) {
    console.error("[publicData] 공원 API 오류:", err);
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
