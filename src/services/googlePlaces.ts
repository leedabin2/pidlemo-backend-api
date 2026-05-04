import type { Coordinates } from "../types";
import { recordQuotaUsage } from "./quotaTracker";
import { logger } from "../utils/logger";

const GOOGLE_KEY = process.env.GOOGLE_PLACES_API_KEY ?? "";
// 정적 데이터는 짧게 캐시하고, 영업 여부는 periods로 매 요청 시각에 다시 계산
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const WEEK_MINUTES = 7 * 24 * 60;
const KOREA_TIMEZONE = "Asia/Seoul";
const WEEKDAY_TO_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

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
  hasParking?: boolean;
  parkingSummary?: string | null;
  goodForChildren?: boolean;
  menuForChildren?: boolean;
  goodForGroups?: boolean;
  restroom?: boolean;
}

interface CacheEntry {
  placeId: string;
  rating: number | null;
  reviewCount: number | null;
  priceLevel: 0 | 1 | 2 | 3 | 4 | null;
  photoUrl: string | null;
  periods: Period[]; // 영업시간 periods — isOpen은 캐시 안 함, 매번 실시간 계산
  hasParking?: boolean;
  parkingSummary?: string | null;
  goodForChildren?: boolean;
  menuForChildren?: boolean;
  goodForGroups?: boolean;
  restroom?: boolean;
  expiresAt: number;
}

export interface PlaceAtmosphereOptions {
  parking?: boolean;
  children?: boolean;
  groups?: boolean;
}

export interface PlaceAtmosphereDetails {
  hasParking?: boolean;
  parkingSummary?: string | null;
  goodForChildren?: boolean;
  menuForChildren?: boolean;
  goodForGroups?: boolean;
  restroom?: boolean;
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

function getKoreaTimeParts(date: Date): { day: number; hours: number; minutes: number } {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: KOREA_TIMEZONE,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = formatter.formatToParts(date);
  const weekday = parts.find((part) => part.type === "weekday")?.value ?? "Sun";
  const hours = parseInt(parts.find((part) => part.type === "hour")?.value ?? "0", 10);
  const minutes = parseInt(parts.find((part) => part.type === "minute")?.value ?? "0", 10);
  return {
    day: WEEKDAY_TO_INDEX[weekday] ?? 0,
    hours,
    minutes,
  };
}

function getWeekMinutes(date: Date): number {
  const { day, hours, minutes } = getKoreaTimeParts(date);
  return day * 24 * 60 + hours * 60 + minutes;
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

function buildHoursFromPeriods(periods: Period[], openNowOverride?: boolean): PlaceHours | null {
  if (!periods.length) return null;

  const now = new Date();
  return {
    isOpenNow: openNowOverride ?? isOpenAtDate(periods, now),
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
  const today = getKoreaTimeParts(new Date()).day;
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
    hasParking: entry.hasParking,
    parkingSummary: entry.parkingSummary,
    goodForChildren: entry.goodForChildren,
    menuForChildren: entry.menuForChildren,
    goodForGroups: entry.goodForGroups,
    restroom: entry.restroom,
  };
}

function atmosphereFieldsMask(options: PlaceAtmosphereOptions): string | null {
  const fields = new Set<string>();
  if (options.parking) fields.add("parkingOptions");
  if (options.children) {
    fields.add("goodForChildren");
    fields.add("menuForChildren");
    fields.add("restroom");
  }
  if (options.groups) {
    fields.add("goodForGroups");
    fields.add("reservable");
  }
  return fields.size > 0 ? [...fields].join(",") : null;
}

function formatParkingSummary(parkingOptions?: Record<string, boolean>): { hasParking?: boolean; parkingSummary?: string | null } {
  if (!parkingOptions) return {};

  const labels: string[] = [];
  if (parkingOptions.freeParkingLot || parkingOptions.freeGarageParking) labels.push("무료 주차");
  if (parkingOptions.paidParkingLot || parkingOptions.paidGarageParking) labels.push("유료 주차");
  if (parkingOptions.freeStreetParking) labels.push("무료 노상 주차");
  if (parkingOptions.paidStreetParking) labels.push("유료 노상 주차");
  if (parkingOptions.valetParking) labels.push("발렛 주차");

  const hasParking = labels.length > 0;
  return {
    hasParking,
    parkingSummary: hasParking ? labels.join(" · ") : null,
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

// 구글이 광역시 단위만 반환한 경우 (구/동/로/길/번길 없음) → 주소 검증 불가
function isBroadAddress(address: string): boolean {
  return !/[구동로길지번]/.test(address);
}

function addressesLookCompatible(
  expectedAddress: string | undefined,
  candidateAddress: string | undefined,
  distanceMeters: number
): boolean {
  if (!expectedAddress || !candidateAddress) return true;
  if (distanceMeters <= 80) return true;
  // 구글 주소가 너무 광범위하면 검증 스킵 — 거리(distance)로만 판단
  if (isBroadAddress(candidateAddress)) return true;

  const expectedTokens = expectedAddress
    .split(/\s+/)
    .map((token) => token.replace(/[(),]/g, "").trim())
    .filter((token) => token.length >= 2)
    .slice(0, 5);
  const normalizedCandidate = candidateAddress.replace(/\s+/g, " ");

  if (expectedTokens.length === 0) return true;
  const matched = expectedTokens.filter((token) => normalizedCandidate.includes(token));
  const minMatches = distanceMeters <= 180 ? 1 : Math.min(2, expectedTokens.length);
  return matched.length >= minMatches;
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
    logger.info("googlePlaces", "후보 제외: 거리 불일치", {
      candidate: candidate.name,
      expected: expectedName,
      distance: `${Math.round(distanceMeters)}m`,
    });
    return false;
  }

  if (!addressesLookCompatible(expectedAddress, candidate.formatted_address, distanceMeters)) {
    logger.info("googlePlaces", "후보 제외: 주소 불일치", {
      candidate: candidate.name,
      expectedAddress,
      candidateAddress: candidate.formatted_address,
    });
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
  recordQuotaUsage("google_find_place_legacy_pro");
  const res = await fetch(url);
  const json = await res.json() as { status?: string; candidates?: FindPlaceCandidate[] };
  logger.info("googlePlaces", "findPlace", {
    query,
    status: json.status,
    candidates: json.candidates?.length ?? 0,
  });

  const matched = json.candidates?.find((candidate) =>
    isValidCandidate(candidate, expectedName, coords, expectedAddress)
  );
  return matched?.place_id ?? null;
}

// 카카오 전화번호(032-123-4567) → 국제 형식(+8232123456789) 변환
function toInternationalPhone(phone: string): string | null {
  const digits = phone.replace(/\D/g, "");
  if (!digits) return null;
  // 0으로 시작하는 국내 번호 → +82 접두
  if (digits.startsWith("0")) return `+82${digits.slice(1)}`;
  return null;
}

async function findPlaceIdByPhone(
  phone: string,
  expectedName: string,
  coords: Coordinates,
  expectedAddress?: string
): Promise<string | null> {
  const intlPhone = toInternationalPhone(phone);
  if (!intlPhone) return null;

  const input = encodeURIComponent(intlPhone);
  const fields = ["place_id", "name", "formatted_address", "geometry"].join(",");
  const url = `https://maps.googleapis.com/maps/api/place/findplacefromtext/json?input=${input}&inputtype=phonenumber&locationbias=circle:2000@${coords.lat},${coords.lng}&fields=${fields}&key=${GOOGLE_KEY}&language=ko`;
  recordQuotaUsage("google_find_place_legacy_pro");
  const res = await fetch(url);
  const json = await res.json() as { status?: string; candidates?: FindPlaceCandidate[] };
  logger.info("googlePlaces", "findPlace by phone", {
    phone: intlPhone,
    status: json.status,
    candidates: json.candidates?.length ?? 0,
  });

  const matched = json.candidates?.find((candidate) => {
    if (!candidate.name || !candidate.geometry?.location) return false;
    if (!namesLookCompatible(expectedName, candidate.name)) return false;
    const distanceMeters = haversineDistanceMeters(coords, {
      lat: candidate.geometry.location.lat,
      lng: candidate.geometry.location.lng,
    });
    if (distanceMeters > PRIMARY_MATCH_MAX_DISTANCE_METERS) return false;
    return addressesLookCompatible(expectedAddress, candidate.formatted_address, distanceMeters);
  });
  if (matched) {
    logger.info("googlePlaces", "전화번호 매칭 성공", {
      expected: expectedName,
      matched: matched.name,
    });
  }
  return matched?.place_id ?? null;
}

async function findPlaceId(
  name: string,
  coords: Coordinates,
  address?: string,
  phone?: string
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
      logger.info("googlePlaces", "지점명 제거로 매칭", {
        original: name,
        stripped,
      });
      return id2;
    }
  }

  // 3차: 카카오 전화번호로 검색
  if (phone) {
    const id3 = await findPlaceIdByPhone(phone, name, coords, address);
    if (id3) return id3;
  }

  logger.warn("googlePlaces", "place_id를 찾지 못함", { name });
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
  recordQuotaUsage("google_place_details_legacy_pro");
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
    ? buildHoursFromPeriods(result.opening_hours.periods, result.opening_hours.open_now)
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

async function fetchPlaceAtmosphere(
  placeId: string,
  options: PlaceAtmosphereOptions
): Promise<PlaceAtmosphereDetails> {
  const fieldMask = atmosphereFieldsMask(options);
  if (!fieldMask) return {};

  const url = `https://places.googleapis.com/v1/places/${placeId}`;
  recordQuotaUsage("google_place_details_enterprise_atmosphere");
  const res = await fetch(url, {
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": GOOGLE_KEY,
      "X-Goog-FieldMask": fieldMask,
    },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    logger.warn("googlePlaces", "Places API (New) atmosphere 조회 실패", {
      placeId,
      status: res.status,
      body,
    });
    return {};
  }

  const json = await res.json() as {
    parkingOptions?: Record<string, boolean>;
    goodForChildren?: boolean;
    menuForChildren?: boolean;
    goodForGroups?: boolean;
    restroom?: boolean;
  };

  logger.info("placesNew", "✨ Places API (New) atmosphere 응답", {
    placeId,
    fieldMask,
    parking: json.parkingOptions ? "Y" : "N",
    goodForChildren: json.goodForChildren,
    menuForChildren: json.menuForChildren,
    goodForGroups: json.goodForGroups,
    restroom: json.restroom,
  });

  return {
    ...formatParkingSummary(json.parkingOptions),
    goodForChildren: json.goodForChildren,
    menuForChildren: json.menuForChildren,
    goodForGroups: json.goodForGroups,
    restroom: json.restroom,
  };
}

export async function getPlaceDetails(
  name: string,
  coords: Coordinates,
  address?: string,
  phone?: string
): Promise<PlaceDetails | null> {
  if (!GOOGLE_KEY) return null;

  const key = `${name}|${address ?? ""}|${coords.lat.toFixed(4)},${coords.lng.toFixed(4)}`;
  const cached = cache.get(key);
  if (cached && Date.now() < cached.expiresAt) return detailsFromCache(cached);

  try {
    const placeId = await findPlaceId(name, coords, address, phone);
    if (!placeId) {
      logger.warn("googlePlaces", "검증 가능한 place_id를 찾지 못함", { name });
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
      hasParking: details.hasParking,
      parkingSummary: details.parkingSummary,
      goodForChildren: details.goodForChildren,
      menuForChildren: details.menuForChildren,
      goodForGroups: details.goodForGroups,
      restroom: details.restroom,
      expiresAt: Date.now() + CACHE_TTL_MS,
    });
    logger.info("googlePlaces", "기본 상세 보강 완료", {
      name,
      rating: details.rating ?? "-",
      reviews: details.reviewCount ?? "-",
      open: details.hours?.isOpenNow,
    });
    return details;
  } catch (err) {
    logger.error("googlePlaces", "기본 상세 보강 오류", {
      name,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

export async function getPlaceAtmosphere(
  name: string,
  coords: Coordinates,
  options: PlaceAtmosphereOptions,
  address?: string,
  phone?: string
): Promise<PlaceAtmosphereDetails | null> {
  if (!GOOGLE_KEY) return null;

  const key = `${name}|${address ?? ""}|${coords.lat.toFixed(4)},${coords.lng.toFixed(4)}`;
  const cached = cache.get(key);
  const fieldMask = atmosphereFieldsMask(options);
  if (!fieldMask) return null;

  const alreadySatisfied =
    (!options.parking || cached?.parkingSummary !== undefined || cached?.hasParking !== undefined) &&
    (!options.children || cached?.goodForChildren !== undefined || cached?.menuForChildren !== undefined || cached?.restroom !== undefined) &&
    (!options.groups || cached?.goodForGroups !== undefined);

  if (cached && Date.now() < cached.expiresAt && alreadySatisfied) {
    const intentBadges = [
      options.children ? "🧒 아이동반" : null,
      options.parking ? "🚗 주차" : null,
      options.groups ? "👥 단체" : null,
    ].filter(Boolean).join(" + ");
    logger.info("placesNew", "♻️ 캐시 HIT", {
      name,
      intent: intentBadges || "기본",
      parking: cached.hasParking,
      goodForChildren: cached.goodForChildren,
      goodForGroups: cached.goodForGroups,
    });
    return {
      hasParking: cached.hasParking,
      parkingSummary: cached.parkingSummary,
      goodForChildren: cached.goodForChildren,
      menuForChildren: cached.menuForChildren,
      goodForGroups: cached.goodForGroups,
      restroom: cached.restroom,
    };
  }

  try {
    const placeId = cached?.placeId ?? await findPlaceId(name, coords, address, phone);
    if (!placeId) {
      logger.warn("googlePlaces", "atmosphere 조회용 place_id를 찾지 못함", { name });
      return null;
    }

    const intentBadges = [
      options.children ? "🧒 아이동반" : null,
      options.parking ? "🚗 주차" : null,
      options.groups ? "👥 단체" : null,
    ].filter(Boolean).join(" + ");
    logger.info("placesNew", "조회 시작", {
      name,
      placeId,
      intent: intentBadges || "기본",
    });

    const atmosphere = await fetchPlaceAtmosphere(placeId, options);
    const nextCache: CacheEntry = {
      placeId,
      rating: cached?.rating ?? null,
      reviewCount: cached?.reviewCount ?? null,
      priceLevel: cached?.priceLevel ?? null,
      photoUrl: cached?.photoUrl ?? null,
      periods: cached?.periods ?? [],
      hasParking: atmosphere.hasParking ?? cached?.hasParking,
      parkingSummary: atmosphere.parkingSummary ?? cached?.parkingSummary ?? null,
      goodForChildren: atmosphere.goodForChildren ?? cached?.goodForChildren,
      menuForChildren: atmosphere.menuForChildren ?? cached?.menuForChildren,
      goodForGroups: atmosphere.goodForGroups ?? cached?.goodForGroups,
      restroom: atmosphere.restroom ?? cached?.restroom,
      expiresAt: Date.now() + CACHE_TTL_MS,
    };
    cache.set(key, nextCache);
    logger.info("placesNew", "✅ Places API (New) 보강 완료", {
      name,
      intent: intentBadges || "기본",
      parking: atmosphere.hasParking,
      parkingSummary: atmosphere.parkingSummary ?? "-",
      goodForChildren: atmosphere.goodForChildren,
      menuForChildren: atmosphere.menuForChildren,
      goodForGroups: atmosphere.goodForGroups,
      restroom: atmosphere.restroom,
    });
    return atmosphere;
  } catch (err) {
    logger.error("placesNew", "❌ Places API (New) 보강 오류", {
      name,
      error: err instanceof Error ? err.message : String(err),
    });
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
