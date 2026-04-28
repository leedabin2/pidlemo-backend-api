import type { Coordinates } from "../types";

const GOOGLE_KEY = process.env.GOOGLE_PLACES_API_KEY ?? "";
// 정적 데이터는 짧게 캐시하고, 영업 여부는 periods로 매 요청 시각에 다시 계산
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const WEEK_MINUTES = 7 * 24 * 60;

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
  placeId: string;
  rating: number | null;
  reviewCount: number | null;
  priceLevel: 0 | 1 | 2 | 3 | 4 | null;
  photoUrl: string | null;
  periods: Period[]; // 영업시간 periods — isOpen은 캐시 안 함, 매번 실시간 계산
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();
const PRIMARY_MATCH_MAX_DISTANCE_METERS = 220;
const STRIPPED_MATCH_MAX_DISTANCE_METERS = 120;

interface FindPlaceCandidate {
  place_id: string;
  name?: string;
  formatted_address?: string;
  geometry?: {
    location?: {
      lat: number;
      lng: number;
    };
  };
}

function timeStringToMinutes(time: string): number {
  const h = parseInt(time.slice(0, 2), 10);
  const m = parseInt(time.slice(2, 4), 10);
  return h * 60 + m;
}

function haversineDistanceMeters(a: Coordinates, b: Coordinates): number {
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

function toWeekMinutes(day: number, time: string): number {
  return day * 24 * 60 + timeStringToMinutes(time);
}

function getWeekMinutes(date: Date): number {
  return date.getDay() * 24 * 60 + date.getHours() * 60 + date.getMinutes();
}

function getNormalizedCloseMinutes(period: Period): number | null {
  if (!period.close) return null;

  const openMinutes = toWeekMinutes(period.open.day, period.open.time);
  let closeMinutes = toWeekMinutes(period.close.day, period.close.time);
  if (closeMinutes <= openMinutes) closeMinutes += WEEK_MINUTES;
  return closeMinutes;
}

function containsWeekMinute(period: Period, weekMinutes: number): boolean {
  const openMinutes = toWeekMinutes(period.open.day, period.open.time);
  const closeMinutes = getNormalizedCloseMinutes(period);

  if (closeMinutes === null) return true;
  if (weekMinutes >= openMinutes && weekMinutes < closeMinutes) return true;
  if (weekMinutes + WEEK_MINUTES >= openMinutes && weekMinutes + WEEK_MINUTES < closeMinutes) {
    return true;
  }

  return false;
}

function isOpenAtDate(periods: Period[], target: Date): boolean {
  const weekMinutes = getWeekMinutes(target);
  return periods.some((period) => containsWeekMinute(period, weekMinutes));
}

function calcClosesInMinutesAt(periods: Period[], target: Date): number | null {
  const weekMinutes = getWeekMinutes(target);

  for (const period of periods) {
    if (!containsWeekMinute(period, weekMinutes)) continue;

    const closeMinutes = getNormalizedCloseMinutes(period);
    if (closeMinutes === null) return null;

    const openMinutes = toWeekMinutes(period.open.day, period.open.time);
    const effectiveWeekMinutes =
      weekMinutes >= openMinutes ? weekMinutes : weekMinutes + WEEK_MINUTES;

    return Math.max(0, closeMinutes - effectiveWeekMinutes);
  }

  return null;
}

function buildHoursFromPeriods(periods: Period[]): PlaceHours | null {
  if (!periods.length) return null;

  const now = new Date();
  return {
    isOpenNow: isOpenAtDate(periods, now),
    closesAtMinutesFromNow: calcClosesInMinutesAt(periods, now),
    periods,
  };
}

function formatMinutesToTime(minutes: number): string {
  const hh = String(Math.floor(minutes / 60)).padStart(2, "0");
  const mm = String(minutes % 60).padStart(2, "0");
  return `${hh}:${mm}`;
}

export function formatOperatingHoursLabel(hours: PlaceHours): string {
  const today = new Date().getDay();
  const windows: string[] = [];

  for (const period of hours.periods) {
    if (!period.close) return "24시간";

    const openMinutes = timeStringToMinutes(period.open.time);
    const closeMinutes = timeStringToMinutes(period.close.time);
    const isOvernight = period.close.day !== period.open.day || closeMinutes <= openMinutes;

    if (period.open.day === today) {
      windows.push(`${formatMinutesToTime(openMinutes)}-${formatMinutesToTime(closeMinutes)}`);
      continue;
    }

    if (isOvernight && period.close.day === today) {
      windows.push(`00:00-${formatMinutesToTime(closeMinutes)}`);
    }
  }

  if (windows.length === 0) {
    return hours.isOpenNow ? "오늘 운영중" : "오늘 휴무";
  }

  return windows.join(" / ");
}

function detailsFromCache(entry: CacheEntry): PlaceDetails {
  return {
    hours: buildHoursFromPeriods(entry.periods),
    rating: entry.rating,
    reviewCount: entry.reviewCount,
    priceLevel: entry.priceLevel,
    photoUrl: entry.photoUrl,
  };
}

// "플러스82프로젝트 양재점" → "플러스82프로젝트" (지점명 제거)
function stripBranchSuffix(name: string): string {
  return name.replace(/\s*[가-힣A-Za-z0-9]+점$/, "").trim();
}

function normalizeText(value: string): string {
  return value.toLowerCase().replace(/[^가-힣a-z0-9]/g, "");
}

function namesLookCompatible(expectedName: string, candidateName: string): "primary" | "stripped" | null {
  const normalizedExpected = normalizeText(expectedName);
  const normalizedCandidate = normalizeText(candidateName);
  if (!normalizedExpected || !normalizedCandidate) return null;

  if (
    normalizedExpected === normalizedCandidate ||
    normalizedCandidate.includes(normalizedExpected) ||
    normalizedExpected.includes(normalizedCandidate)
  ) {
    return "primary";
  }

  const strippedExpected = normalizeText(stripBranchSuffix(expectedName));
  if (
    strippedExpected &&
    strippedExpected !== normalizedExpected &&
    (
      strippedExpected === normalizedCandidate ||
      normalizedCandidate.includes(strippedExpected) ||
      strippedExpected.includes(normalizedCandidate)
    )
  ) {
    return "stripped";
  }

  return null;
}

function addressesLookCompatible(expectedAddress?: string, candidateAddress?: string): boolean {
  if (!expectedAddress || !candidateAddress) return true;

  const expectedTokens = expectedAddress
    .split(/\s+/)
    .map((token) => token.replace(/[(),]/g, "").trim())
    .filter((token) => token.length >= 2)
    .slice(0, 5);
  const normalizedCandidate = candidateAddress.replace(/\s+/g, " ");

  if (expectedTokens.length === 0) return true;
  const matched = expectedTokens.filter((token) => normalizedCandidate.includes(token));
  return matched.length >= Math.min(2, expectedTokens.length);
}

function isValidCandidate(
  candidate: FindPlaceCandidate,
  expectedName: string,
  coords: Coordinates,
  expectedAddress?: string
): boolean {
  if (!candidate.name || !candidate.geometry?.location) return false;

  const matchType = namesLookCompatible(expectedName, candidate.name);
  if (!matchType) return false;

  const distanceMeters = haversineDistanceMeters(coords, {
    lat: candidate.geometry.location.lat,
    lng: candidate.geometry.location.lng,
  });
  const maxDistance =
    matchType === "primary" ? PRIMARY_MATCH_MAX_DISTANCE_METERS : STRIPPED_MATCH_MAX_DISTANCE_METERS;
  if (distanceMeters > maxDistance) {
    console.log(
      `[googlePlaces] reject candidate "${candidate.name}" distance=${Math.round(distanceMeters)}m expected="${expectedName}"`
    );
    return false;
  }

  if (!addressesLookCompatible(expectedAddress, candidate.formatted_address)) {
    console.log(
      `[googlePlaces] reject candidate "${candidate.name}" address mismatch expected="${expectedAddress}" candidate="${candidate.formatted_address}"`
    );
    return false;
  }

  return true;
}

async function findPlaceIdByQuery(
  query: string,
  expectedName: string,
  coords: Coordinates,
  expectedAddress?: string
): Promise<string | null> {
  const input = encodeURIComponent(query);
  const fields = ["place_id", "name", "formatted_address", "geometry"].join(",");
  const url = `https://maps.googleapis.com/maps/api/place/findplacefromtext/json?input=${input}&inputtype=textquery&locationbias=circle:1500@${coords.lat},${coords.lng}&fields=${fields}&key=${GOOGLE_KEY}&language=ko`;
  const res = await fetch(url);
  const json = await res.json() as { status?: string; candidates?: FindPlaceCandidate[] };
  console.log(`[googlePlaces] findPlace "${query}" → status:${json.status} candidates:${json.candidates?.length ?? 0}`);

  const matched = json.candidates?.find((candidate) =>
    isValidCandidate(candidate, expectedName, coords, expectedAddress)
  );
  return matched?.place_id ?? null;
}

async function findPlaceId(
  name: string,
  coords: Coordinates,
  address?: string
): Promise<string | null> {
  if (!GOOGLE_KEY) return null;

  // 1차: 원래 이름
  const id = await findPlaceIdByQuery(name, name, coords, address);
  if (id) return id;

  // 2차: 지점명 제거 후 재시도
  const stripped = stripBranchSuffix(name);
  if (stripped && stripped !== name) {
    const id2 = await findPlaceIdByQuery(stripped, name, coords, address);
    if (id2) {
      console.log(`[googlePlaces] 지점명 제거로 매칭: "${name}" → "${stripped}"`);
      return id2;
    }
  }

  console.log(`[googlePlaces] place_id 못 찾음: ${name}`);
  return null;
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
    ? buildHoursFromPeriods(result.opening_hours.periods)
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
  coords: Coordinates,
  address?: string
): Promise<PlaceDetails | null> {
  if (!GOOGLE_KEY) return null;

  const key = `${name}|${address ?? ""}|${coords.lat.toFixed(4)},${coords.lng.toFixed(4)}`;
  const cached = cache.get(key);
  if (cached && Date.now() < cached.expiresAt) return detailsFromCache(cached);

  try {
    const placeId = await findPlaceId(name, coords, address);
    if (!placeId) {
      console.log(`[googlePlaces] 검증 가능한 place_id 못 찾음: ${name}`);
      return null;
    }

    const details = await fetchPlaceDetails(placeId);
    cache.set(key, {
      placeId,
      rating: details.rating,
      reviewCount: details.reviewCount,
      priceLevel: details.priceLevel,
      photoUrl: details.photoUrl,
      periods: details.hours?.periods ?? [],
      expiresAt: Date.now() + CACHE_TTL_MS,
    });
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
  coords: Coordinates,
  address?: string
): Promise<PlaceHours | null> {
  const details = await getPlaceDetails(name, coords, address);
  return details?.hours ?? null;
}

// 도착 예상 시간(offsetMinutes 후)에 영업 중인지
export function isOpenAtOffset(hours: PlaceHours, offsetMinutes: number): boolean | null {
  if (!hours.periods.length) return null;

  const future = new Date(Date.now() + offsetMinutes * 60_000);
  return isOpenAtDate(hours.periods, future);
}
