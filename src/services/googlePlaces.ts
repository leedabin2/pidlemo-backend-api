import type { Coordinates } from "../types";

const GOOGLE_KEY = process.env.GOOGLE_PLACES_API_KEY ?? "";
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6시간

interface Period {
  open: { day: number; time: string };
  close?: { day: number; time: string };
}

export interface PlaceHours {
  isOpenNow: boolean;
  closesAtMinutesFromNow: number | null; // null = 알 수 없음 or 24시간
  periods: Period[];
}

export interface PlaceDetails {
  hours: PlaceHours | null;
  rating: number | null;
  reviewCount: number | null;
  priceLevel: 0 | 1 | 2 | 3 | 4 | null;
  photoUrl: string | null;
}

interface CacheEntry {
  details: PlaceDetails;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

function timeStringToMinutes(time: string): number {
  const h = parseInt(time.slice(0, 2), 10);
  const m = parseInt(time.slice(2, 4), 10);
  return h * 60 + m;
}

function nowMinutes(): number {
  const now = new Date();
  return now.getHours() * 60 + now.getMinutes();
}

function calcClosesInMinutes(periods: Period[]): number | null {
  const now = new Date();
  const dayOfWeek = now.getDay();
  const currentMin = nowMinutes();

  for (const p of periods) {
    if (p.open.day !== dayOfWeek) continue;
    const openMin = timeStringToMinutes(p.open.time);
    if (!p.close) return null; // 24시간

    const closeDay = p.close.day;
    const closeMin = timeStringToMinutes(p.close.time);

    if (closeDay === dayOfWeek) {
      if (currentMin >= openMin && currentMin < closeMin) {
        return closeMin - currentMin;
      }
    } else {
      // 자정 넘어 마감
      if (currentMin >= openMin) {
        return 24 * 60 - currentMin + closeMin;
      }
    }
  }
  return null;
}

async function findPlaceId(name: string, coords: Coordinates): Promise<string | null> {
  if (!GOOGLE_KEY) return null;
  const input = encodeURIComponent(name);
  // language=ko 추가, 반경 1500m로 확대 (한국어 장소명 매칭 개선)
  const url = `https://maps.googleapis.com/maps/api/place/findplacefromtext/json?input=${input}&inputtype=textquery&locationbias=circle:1500@${coords.lat},${coords.lng}&fields=place_id&key=${GOOGLE_KEY}&language=ko`;
  const res = await fetch(url);
  const json = await res.json() as { candidates?: { place_id: string }[] };
  return json.candidates?.[0]?.place_id ?? null;
}

async function fetchPlaceDetails(placeId: string): Promise<PlaceDetails> {
  const fields = [
    "opening_hours",
    "rating",
    "user_ratings_total",
    "price_level",
    "photos",
  ].join(",");

  const url = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${placeId}&fields=${fields}&key=${GOOGLE_KEY}&language=ko`;
  const res = await fetch(url);
  const json = await res.json() as {
    result?: {
      opening_hours?: { open_now: boolean; periods: Period[] };
      rating?: number;
      user_ratings_total?: number;
      price_level?: number;
      photos?: { photo_reference: string }[];
    };
  };

  const result = json.result;
  if (!result) {
    return { hours: null, rating: null, reviewCount: null, priceLevel: null, photoUrl: null };
  }

  const hours: PlaceHours | null = result.opening_hours
    ? {
        isOpenNow: result.opening_hours.open_now,
        closesAtMinutesFromNow: calcClosesInMinutes(result.opening_hours.periods),
        periods: result.opening_hours.periods,
      }
    : null;

  // 대표 사진 URL 생성 (maxwidth=400)
  const photoRef = result.photos?.[0]?.photo_reference ?? null;
  const photoUrl = photoRef
    ? `https://maps.googleapis.com/maps/api/place/photo?maxwidth=400&photo_reference=${photoRef}&key=${GOOGLE_KEY}`
    : null;

  return {
    hours,
    rating: result.rating ?? null,
    reviewCount: result.user_ratings_total ?? null,
    priceLevel: (result.price_level as 0 | 1 | 2 | 3 | 4 | undefined) ?? null,
    photoUrl,
  };
}

export async function getPlaceDetails(
  name: string,
  coords: Coordinates
): Promise<PlaceDetails | null> {
  if (!GOOGLE_KEY) return null;

  const key = `${name}|${coords.lat.toFixed(4)},${coords.lng.toFixed(4)}`;
  const cached = cache.get(key);
  if (cached && Date.now() < cached.expiresAt) return cached.details;

  try {
    const placeId = await findPlaceId(name, coords);
    if (!placeId) {
      console.log(`[googlePlaces] place_id 못 찾음: ${name}`);
      return null;
    }

    const details = await fetchPlaceDetails(placeId);
    cache.set(key, { details, expiresAt: Date.now() + CACHE_TTL_MS });
    console.log(`[googlePlaces] ✅ ${name} → rating:${details.rating} reviews:${details.reviewCount} open:${details.hours?.isOpenNow}`);
    return details;
  } catch (err) {
    console.error(`[googlePlaces] 오류 (${name}):`, err);
    return null;
  }
}

// 하위 호환: 영업시간만 필요한 경우
export async function getPlaceHours(
  name: string,
  coords: Coordinates
): Promise<PlaceHours | null> {
  const details = await getPlaceDetails(name, coords);
  return details?.hours ?? null;
}

// 도착 예상 시간(offsetMinutes 후)에 영업 중인지
export function isOpenAtOffset(hours: PlaceHours, offsetMinutes: number): boolean | null {
  if (!hours.periods.length) return null;

  const future = new Date(Date.now() + offsetMinutes * 60_000);
  const dayOfWeek = future.getDay();
  const futureMin = future.getHours() * 60 + future.getMinutes();

  for (const p of hours.periods) {
    if (p.open.day !== dayOfWeek) continue;
    const openMin = timeStringToMinutes(p.open.time);
    if (!p.close) return true; // 24시간

    const closeMin = timeStringToMinutes(p.close.time);
    const closeDay = p.close.day;

    if (closeDay === dayOfWeek) {
      if (futureMin >= openMin && futureMin < closeMin) return true;
    } else {
      if (futureMin >= openMin) return true;
    }
  }
  return false;
}
