import type { Coordinates, PlaceCategory } from "../types";
import { recordQuotaUsage } from "./quotaTracker";
import { logger } from "../utils/logger";

const GOOGLE_KEY = process.env.GOOGLE_PLACES_API_KEY ?? "";
const KAKAO_KEY = process.env.KAKAO_REST_API_KEY ?? "";
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

interface SpecialDay {
  date?: string;
  exceptional_hours?: boolean;
}

export interface PlaceHours {
  isOpenNow: boolean;
  closesAtMinutesFromNow: number | null; // null = 알 수 없음 or 24시간
  periods: Period[];
}

export interface PlaceDetails {
  hours: PlaceHours | null;
  hoursLabel?: string;
  hoursMayDiffer?: boolean;
  rating: number | null;
  reviewCount: number | null;
  priceLevel: 0 | 1 | 2 | 3 | 4 | null;
  photoUrl: string | null;
  resolvedName?: string;
  resolvedAddress?: string;
  resolvedPhone?: string | null;
  types?: string[];
  resolvedCoords?: Coordinates;
  resolvedStructuredAddress?: StructuredAddress;
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

interface ResolvedIdentity {
  name?: string;
  formattedAddress?: string;
  phone?: string | null;
  types?: string[];
  coords?: Coordinates;
  structuredAddress?: StructuredAddress;
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
const kakaoAddressCache = new Map<string, { value: StructuredAddress | null; expiresAt: number }>();
const atmosphereCache = new Map<string, { details: PlaceAtmosphereDetails; expiresAt: number }>();
const atmosphereInFlight = new Map<string, Promise<PlaceAtmosphereDetails>>();
const PRIMARY_MATCH_MAX_DISTANCE_METERS = 220;

// ── New Places API 후보 검색 ──────────────────────────────────────────
const SEARCH_FIELD_MASK = "places.id,places.displayName,places.formattedAddress,places.location,places.types,places.businessStatus";

interface NewApiCandidate {
  id: string;
  displayName?: { text: string };
  formattedAddress?: string;
  location?: { latitude: number; longitude: number };
  types?: string[];
}

interface FindPlaceCandidate {
  place_id?: string;
  name?: string;
  formatted_address?: string;
  geometry?: {
    location?: {
      lat: number;
      lng: number;
    };
  };
}

interface ScoredCandidate {
  id: string;
  displayName: string;
  baseScore: number;
  distanceScore: number;
  nameScore: number;
  addressScore: number;
  categoryScore: number;
  distanceMeters: number;
  formattedAddress?: string;
  types?: string[];
}

interface MatchResolution {
  placeId: string;
  score: number;
  candidateName: string;
  details?: PlaceDetails;
}

interface StructuredAddress {
  region1?: string;
  region2?: string;
  region3?: string;
  roadName?: string;
  mainBuildingNo?: string;
  subBuildingNo?: string;
  legalDong?: string;
  lotMainNo?: string;
  lotSubNo?: string;
  buildingName?: string;
  zoneNo?: string;
}

interface GoogleAddressComponent {
  long_name?: string;
  short_name?: string;
  types?: string[];
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

function currentWeekdayTextLabel(weekdayText?: string[]): string | undefined {
  if (!weekdayText || weekdayText.length === 0) return undefined;
  const todayIndex = getKoreaTimeParts(new Date()).day;
  const todayLine = weekdayText[todayIndex];
  if (!todayLine) return undefined;

  const [, rest] = todayLine.split(/:\s*/, 2);
  return rest ? todayLine.replace(/:\s+/, " ") : todayLine;
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

function hasAtmosphereFields(
  details: PlaceAtmosphereDetails | undefined,
  options: PlaceAtmosphereOptions,
): boolean {
  if (!details) return false;
  if (options.parking && details.hasParking === undefined && details.parkingSummary === undefined) return false;
  if (options.children && details.goodForChildren === undefined && details.menuForChildren === undefined && details.restroom === undefined) return false;
  if (options.groups && details.goodForGroups === undefined) return false;
  return true;
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

function normalizeAddressPart(value?: string | null): string {
  return (value ?? "").replace(/\s+/g, "").toLowerCase();
}

function coordCacheKey(coords: Coordinates): string {
  return `${coords.lat.toFixed(5)},${coords.lng.toFixed(5)}`;
}

function parseStructuredAddressFromString(address?: string): StructuredAddress | null {
  if (!address) return null;

  const region1 = address.match(/(서울특별시|서울시|부산광역시|대구광역시|인천광역시|광주광역시|대전광역시|울산광역시|세종특별자치시|경기도|강원특별자치도|충청북도|충청남도|전북특별자치도|전라남도|경상북도|경상남도|제주특별자치도)/)?.[1];
  const region2 = address.match(/([가-힣]+(?:구|군|시))/)?.[1];
  const region3 = address.match(/([가-힣0-9]+(?:동|읍|면|리))/)?.[1];
  const road = address.match(/([가-힣0-9]+(?:로|길|대로))/)?.[1];
  const roadNo = address.match(/(?:로|길|대로)\s*(\d+)(?:-(\d+))?/) ?? null;
  const lot = address.match(/(?:동\s*)?(\d+)(?:-(\d+))?(?![0-9])/);

  return {
    region1,
    region2,
    region3,
    roadName: road,
    mainBuildingNo: roadNo?.[1],
    subBuildingNo: roadNo?.[2],
    legalDong: region3,
    lotMainNo: !road ? lot?.[1] : undefined,
    lotSubNo: !road ? lot?.[2] : undefined,
  };
}

async function fetchKakaoStructuredAddress(coords: Coordinates, fallbackAddress?: string): Promise<StructuredAddress | null> {
  const cacheKey = coordCacheKey(coords);
  const cached = kakaoAddressCache.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt) return cached.value;

  let resolved: StructuredAddress | null = null;

  if (KAKAO_KEY) {
    try {
      const url = `https://dapi.kakao.com/v2/local/geo/coord2address.json?x=${coords.lng}&y=${coords.lat}`;
      const res = await fetch(url, {
        headers: { Authorization: `KakaoAK ${KAKAO_KEY}` },
      });

      if (res.ok) {
        const json = await res.json() as {
          documents?: Array<{
            road_address?: {
              region_1depth_name?: string;
              region_2depth_name?: string;
              region_3depth_name?: string;
              road_name?: string;
              main_building_no?: string;
              sub_building_no?: string;
              building_name?: string;
              zone_no?: string;
            };
            address?: {
              region_1depth_name?: string;
              region_2depth_name?: string;
              region_3depth_name?: string;
              main_address_no?: string;
              sub_address_no?: string;
            };
          }>;
        };

        const doc = json.documents?.[0];
        if (doc) {
          resolved = {
            region1: doc.road_address?.region_1depth_name ?? doc.address?.region_1depth_name,
            region2: doc.road_address?.region_2depth_name ?? doc.address?.region_2depth_name,
            region3: doc.road_address?.region_3depth_name ?? doc.address?.region_3depth_name,
            roadName: doc.road_address?.road_name,
            mainBuildingNo: doc.road_address?.main_building_no,
            subBuildingNo: doc.road_address?.sub_building_no,
            legalDong: doc.address?.region_3depth_name,
            lotMainNo: doc.address?.main_address_no,
            lotSubNo: doc.address?.sub_address_no,
            buildingName: doc.road_address?.building_name,
            zoneNo: doc.road_address?.zone_no,
          };
        }
      }
    } catch (error) {
      logger.warn("googlePlaces", "카카오 coord2address 실패", {
        coords: cacheKey,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (!resolved && fallbackAddress) {
    resolved = parseStructuredAddressFromString(fallbackAddress);
  }

  kakaoAddressCache.set(cacheKey, {
    value: resolved,
    expiresAt: Date.now() + CACHE_TTL_MS,
  });

  return resolved;
}

function parseGoogleStructuredAddress(
  components?: GoogleAddressComponent[],
  fallbackAddress?: string,
): StructuredAddress | null {
  if (!components || components.length === 0) {
    return parseStructuredAddressFromString(fallbackAddress);
  }

  const findAny = (...types: string[]) =>
    components.find((component) => component.types?.some((type) => types.includes(type)));

  return {
    region1: findAny("administrative_area_level_1")?.long_name,
    region2: findAny("administrative_area_level_2")?.long_name,
    region3: findAny("sublocality_level_1", "administrative_area_level_3", "locality", "sublocality")?.long_name,
    roadName: findAny("route")?.long_name,
    mainBuildingNo: findAny("street_number")?.long_name,
    legalDong: findAny("neighborhood", "sublocality_level_2", "sublocality_level_1")?.long_name,
    buildingName: findAny("premise")?.long_name,
    zoneNo: findAny("postal_code")?.long_name,
  };
}

function compareStructuredAddress(
  expected?: StructuredAddress | null,
  candidate?: StructuredAddress | null,
): number {
  if (!expected || !candidate) return 0;

  const expectedRoad = normalizeAddressPart(expected.roadName);
  const candidateRoad = normalizeAddressPart(candidate.roadName);
  const expectedBuildingNo = normalizeAddressPart(expected.mainBuildingNo);
  const candidateBuildingNo = normalizeAddressPart(candidate.mainBuildingNo);

  if (expectedRoad && candidateRoad && expectedRoad === candidateRoad) {
    if (expectedBuildingNo && candidateBuildingNo && expectedBuildingNo === candidateBuildingNo) {
      return 15;
    }
    return 12;
  }

  const expectedDong = normalizeAddressPart(expected.region3 ?? expected.legalDong);
  const candidateDong = normalizeAddressPart(candidate.region3 ?? candidate.legalDong);
  const expectedLotMain = normalizeAddressPart(expected.lotMainNo);
  const candidateLotMain = normalizeAddressPart(candidate.lotMainNo);

  if (expectedDong && candidateDong && expectedDong === candidateDong) {
    if (expectedLotMain && candidateLotMain && expectedLotMain === candidateLotMain) {
      return 12;
    }
    return 8;
  }

  const expectedRegion2 = normalizeAddressPart(expected.region2);
  const candidateRegion2 = normalizeAddressPart(candidate.region2);
  if (expectedRegion2 && candidateRegion2 && expectedRegion2 === candidateRegion2) return 3;

  return 0;
}

function addressesStructuredLookCompatible(
  expected?: StructuredAddress | null,
  candidate?: StructuredAddress | null,
): boolean {
  return compareStructuredAddress(expected, candidate) >= 8;
}

// "플러스82프로젝트 양재점" → "플러스82프로젝트" (지점명 제거)
function stripBranchSuffix(name: string): string {
  return name.replace(/\s*[가-힣A-Za-z0-9]+점$/, "").trim();
}

function normalizeText(value: string): string {
  return value.toLowerCase().replace(/[^가-힣a-z0-9]/g, "");
}

function splitRawNameTokens(value: string): string[] {
  return value
    .split(/[\s/(),[\]{}|·]+/)
    .map((token) => token.trim())
    .filter(Boolean);
}

function normalizeNameToken(token: string): string {
  return normalizeText(token).replace(/(직영점|본점|지점|점)$/g, "");
}

function leadingNameToken(value: string): string {
  const first = splitRawNameTokens(value)[0] ?? value;
  return normalizeNameToken(first);
}

function exactNameLikeMatch(expectedName: string, candidateName: string): boolean {
  const normC = normalizeText(candidateName);
  const normE = normalizeText(expectedName);
  if (!normC || !normE) return false;
  if (normC === normE || normC.includes(normE) || normE.includes(normC)) return true;

  const stripped = normalizeText(stripBranchSuffix(expectedName));
  if (stripped && stripped !== normE && (normC === stripped || normC.includes(stripped) || stripped.includes(normC))) {
    return true;
  }

  return false;
}

function normalizePhone(value: string | undefined | null): string {
  if (!value) return "";
  let digits = value.replace(/\D/g, "");
  if (digits.startsWith("82")) digits = `0${digits.slice(2)}`;
  return digits;
}

function phonesLookCompatible(expectedPhone?: string, resolvedPhone?: string | null): boolean {
  const expected = normalizePhone(expectedPhone);
  const resolved = normalizePhone(resolvedPhone);
  if (!expected || !resolved) return true;
  if (expected === resolved) return true;
  const suffixLen = Math.min(8, expected.length, resolved.length);
  return expected.slice(-suffixLen) === resolved.slice(-suffixLen);
}

function calcPhoneScore(expectedPhone?: string, resolvedPhone?: string | null): number {
  const expected = normalizePhone(expectedPhone);
  const resolved = normalizePhone(resolvedPhone);
  if (!expected || !resolved) return 0;
  if (expected === resolved) return 15;
  const suffixLen = Math.min(8, expected.length, resolved.length);
  if (suffixLen >= 6 && expected.slice(-suffixLen) === resolved.slice(-suffixLen)) return 10;
  return -12;
}

function categoryLooksLikeComplexOrBuilding(types: string[]): boolean {
  return types.includes("shopping_mall") || types.includes("department_store") || types.includes("establishment");
}

function categoryTypeCompatible(expectedCategory: PlaceCategory | undefined, types: string[] | undefined): boolean {
  if (!expectedCategory || !types || types.length === 0) return true;

  const has = (...needles: string[]) => needles.some((needle) => types.includes(needle));

  switch (expectedCategory) {
    case "restaurant":
      return has("restaurant", "meal_takeaway", "meal_delivery", "food");
    case "cafe":
      return has("cafe", "coffee_shop", "bakery", "food");
    case "bar":
      return has("bar", "pub", "restaurant", "food", "night_club");
    case "mall":
      return has("shopping_mall", "department_store", "store");
    case "shopping":
      return has("store", "shopping_mall", "department_store", "clothing_store", "home_goods_store", "book_store");
    case "cinema":
      return has("movie_theater");
    case "park":
      return has("park", "tourist_attraction");
    case "nature":
      return has("park", "tourist_attraction", "zoo", "botanical_garden", "campground");
    case "exhibition":
      return has("museum", "art_gallery", "tourist_attraction", "cultural_center");
    case "photo":
      return has("photographer", "photo_studio", "store");
    case "activity":
      return has("amusement_center", "bowling_alley", "gym", "tourist_attraction", "video_arcade", "sports_complex");
    case "popup":
      return has("event_venue", "art_gallery", "store", "tourist_attraction");
    default:
      return true;
  }
}

function namesLookCompatible(expectedName: string, candidateName: string): boolean {
  if (exactNameLikeMatch(expectedName, candidateName)) return true;

  const normE = normalizeText(expectedName);
  const normC = normalizeText(candidateName);
  if (!normE || !normC) return false;

  const anchorE = leadingNameToken(expectedName);
  const anchorC = leadingNameToken(candidateName);
  if (anchorE && anchorC && anchorE === anchorC) return true;
  if (anchorE && normC.includes(anchorE)) return true;

  return false;
}

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

// ── New Places API 검색 ───────────────────────────────────────────────

async function textSearchNewApi(query: string, center: Coordinates, radiusMeters: number): Promise<NewApiCandidate[]> {
  recordQuotaUsage("google_text_search_new");
  try {
    const res = await fetch("https://places.googleapis.com/v1/places:searchText", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": GOOGLE_KEY,
        "X-Goog-FieldMask": SEARCH_FIELD_MASK,
      },
      body: JSON.stringify({
        textQuery: query,
        languageCode: "ko",
        regionCode: "KR",
        locationBias: { circle: { center: { latitude: center.lat, longitude: center.lng }, radius: radiusMeters } },
        maxResultCount: 10,
      }),
    });
    if (!res.ok) { logger.warn("googlePlaces", "Text Search 실패", { status: res.status }); return []; }
    const json = await res.json() as { places?: NewApiCandidate[] };
    return json.places ?? [];
  } catch (err) {
    logger.warn("googlePlaces", "Text Search 오류", { error: String(err) });
    return [];
  }
}

async function nearbySearchNewApi(center: Coordinates, radiusMeters: number, includedTypes: string[]): Promise<NewApiCandidate[]> {
  recordQuotaUsage("google_nearby_search_new");
  try {
    const body: Record<string, unknown> = {
      locationRestriction: { circle: { center: { latitude: center.lat, longitude: center.lng }, radius: radiusMeters } },
      maxResultCount: 10,
      languageCode: "ko",
    };
    if (includedTypes.length > 0) body.includedTypes = includedTypes;

    const res = await fetch("https://places.googleapis.com/v1/places:searchNearby", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": GOOGLE_KEY,
        "X-Goog-FieldMask": SEARCH_FIELD_MASK,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) { logger.warn("googlePlaces", "Nearby Search 실패", { status: res.status }); return []; }
    const json = await res.json() as { places?: NewApiCandidate[] };
    return json.places ?? [];
  } catch (err) {
    logger.warn("googlePlaces", "Nearby Search 오류", { error: String(err) });
    return [];
  }
}

// ── 매칭 점수 계산 (총 85점 만점: 거리45 + 이름20 + 주소15 + 카테고리5) ──

function calcDistanceScore(loc: { latitude: number; longitude: number } | undefined, expected: Coordinates): number {
  if (!loc) return 0;
  const d = haversineDistanceMeters(expected, { lat: loc.latitude, lng: loc.longitude });
  if (d <= 20)  return 45;
  if (d <= 50)  return 38;
  if (d <= 100) return 28;
  if (d <= 200) return 15;
  return 0;
}

function calcNameScore(candidateName: string | undefined, expectedName: string): number {
  if (!candidateName) return 0;
  if (exactNameLikeMatch(expectedName, candidateName)) return 20;

  const normC = normalizeText(candidateName);
  const normE = normalizeText(expectedName);
  if (!normC || !normE) return 0;

  const stripped = normalizeText(stripBranchSuffix(expectedName));
  if (stripped && stripped !== normE && (normC === stripped || normC.includes(stripped) || stripped.includes(normC))) return 16;

  const anchorE = leadingNameToken(expectedName);
  const anchorC = leadingNameToken(candidateName);
  if (anchorE && anchorC && anchorE === anchorC) return 14;
  if (anchorE && normC.includes(anchorE)) return 12;

  const tokensC = splitRawNameTokens(candidateName)
    .map(normalizeNameToken)
    .filter((token) => token.length >= 2);
  const tokensE = splitRawNameTokens(expectedName)
    .map(normalizeNameToken)
    .filter((token) => token.length >= 2);
  if (tokensE.length === 0) return 0;
  const ratio = tokensE.filter((t) => tokensC.some((c) => c === t || c.includes(t) || t.includes(c))).length / tokensE.length;
  if (ratio >= 0.7) return 12;
  if (ratio >= 0.4) return 6;
  return 0;
}

function calcAddressScore(candidateAddr: string | undefined, expectedAddr: string | undefined): number {
  if (!candidateAddr || !expectedAddr) return 0;

  const roadMatch = expectedAddr.match(/([가-힣]+(?:로|길|대로))\s*(\d+)/);
  if (roadMatch) {
    const [, road, building] = roadMatch;
    if (candidateAddr.includes(road) && candidateAddr.includes(building)) return 15;
    if (candidateAddr.includes(road)) return 12;
  }

  const jiMatch = expectedAddr.match(/([가-힣]+동)\s*(\d+)/);
  if (jiMatch) {
    const [, dong, bon] = jiMatch;
    if (candidateAddr.includes(dong) && candidateAddr.includes(bon)) return 12;
    if (candidateAddr.includes(dong)) return 8;
  }

  const guMatch = expectedAddr.match(/([가-힣]+구)/);
  if (guMatch && candidateAddr.includes(guMatch[1])) return 3;
  return 0;
}

function calcCategoryScore(types: string[] | undefined, category: PlaceCategory | undefined): number {
  if (!types || !category) return 0;
  if (categoryTypeCompatible(category, types)) return 5;

  const isFood = types.some((t) => ["restaurant", "cafe", "food", "bar", "bakery"].includes(t));
  const isCulture = types.some((t) => ["museum", "art_gallery", "tourist_attraction"].includes(t));
  const isShop = types.some((t) => ["store", "shopping_mall", "department_store"].includes(t));
  if (isFood && ["restaurant", "cafe", "bar"].includes(category)) return 3;
  if (isCulture && ["exhibition", "park", "nature"].includes(category)) return 3;
  if (isShop && ["shopping", "mall", "popup"].includes(category)) return 3;
  return 0;
}

function googleTypesForCategory(category?: PlaceCategory): string[] {
  const map: Partial<Record<PlaceCategory, string[]>> = {
    restaurant: ["restaurant"], cafe: ["cafe"], bar: ["bar"],
    mall: ["shopping_mall"], shopping: ["store"], cinema: ["movie_theater"],
    park: ["park"], nature: ["park"], exhibition: ["museum", "art_gallery"],
    photo: ["store"], activity: ["amusement_center"], popup: ["store"],
  };
  return (category && map[category]) ? map[category]! : [];
}

async function findPlaceIdScored(
  name: string,
  coords: Coordinates,
  address?: string,
  expectedCategory?: PlaceCategory,
): Promise<ScoredCandidate[]> {
  if (!GOOGLE_KEY) return [];

  // 1차: 이름+주소 Text Search, 100m locationBias
  const query = address ? `${name} ${address}` : name;
  let candidates = await textSearchNewApi(query, coords, 100);

  // 후보 부족 시 이름만으로 200m 확장
  if (candidates.length < 2) {
    const more = await textSearchNewApi(name, coords, 200);
    const seen = new Set(candidates.map((c) => c.id));
    candidates = [...candidates, ...more.filter((c) => !seen.has(c.id))];
  }

  // 2차: Nearby Search fallback
  if (candidates.length === 0) {
    candidates = await nearbySearchNewApi(coords, 150, googleTypesForCategory(expectedCategory));
  }

  if (candidates.length === 0) {
    logger.warn("googlePlaces", "place_id를 찾지 못함 (후보 없음)", { name });
    return [];
  }

  const scored = candidates
    .map((c) => ({
      id: c.id,
      displayName: c.displayName?.text ?? "",
      distanceScore: calcDistanceScore(c.location, coords),
      nameScore: calcNameScore(c.displayName?.text, name),
      addressScore: calcAddressScore(c.formattedAddress, address),
      categoryScore: calcCategoryScore(c.types, expectedCategory),
      distanceMeters: c.location
        ? haversineDistanceMeters(coords, { lat: c.location.latitude, lng: c.location.longitude })
        : Infinity,
      formattedAddress: c.formattedAddress,
      types: c.types,
    }))
    .filter((candidate) => {
      if (!isTenantLikeCategory(expectedCategory)) return true;
      return namesLookCompatible(name, candidate.displayName);
    })
    .map((c) => ({
      ...c,
      baseScore: c.distanceScore + c.nameScore + c.addressScore + c.categoryScore,
    }))
    .sort((a, b) => b.baseScore - a.baseScore);

  logger.info("googlePlaces", "매칭 점수", {
    name,
    top: scored
      .slice(0, 5)
      .map((s) => `${s.displayName}(${s.baseScore}점/${Math.round(s.distanceMeters)}m)`)
      .join(" | "),
  });
  return scored;
}

function candidateLooksTooBroad(
  details: PlaceDetails,
  expectedName: string,
  expectedCategory?: PlaceCategory,
): boolean {
  if (!details.types || expectedCategory === "mall") return false;
  if (!categoryLooksLikeComplexOrBuilding(details.types)) return false;

  const resolvedName = details.resolvedName ?? "";
  const normalizedResolved = normalizeText(resolvedName);
  const normalizedExpected = normalizeText(expectedName);
  const strippedExpected = normalizeText(stripBranchSuffix(expectedName));

  if (!normalizedResolved) return false;
  if (normalizedResolved === normalizedExpected || normalizedResolved === strippedExpected) return false;

  return true;
}

function isTenantLikeCategory(expectedCategory?: PlaceCategory): boolean {
  return ["restaurant", "cafe", "shopping", "bar", "photo", "activity", "cinema"].includes(
    expectedCategory ?? "",
  );
}

function isTenantLikeResolvedType(types?: string[]): boolean {
  if (!types || types.length === 0) return false;
  return types.some((type) =>
    [
      "restaurant",
      "cafe",
      "coffee_shop",
      "bakery",
      "store",
      "clothing_store",
      "home_goods_store",
      "book_store",
      "bar",
      "pub",
      "movie_theater",
      "amusement_center",
      "video_arcade",
      "gym",
      "sports_complex",
      "museum",
      "art_gallery",
      "photographer",
      "photo_studio",
    ].includes(type),
  );
}

function shouldTryLegacyFallbackForTenant(
  expectedName: string,
  coords: Coordinates,
  expectedCategory: PlaceCategory | undefined,
  evaluated: Array<MatchResolution & { valid: boolean }>,
): boolean {
  if (!isTenantLikeCategory(expectedCategory) || evaluated.length === 0) return false;

  return evaluated.every((item) => {
    const distance =
      item.details?.resolvedCoords ? haversineDistanceMeters(coords, item.details.resolvedCoords) : Infinity;
    const broad = item.details ? candidateLooksTooBroad(item.details, expectedName, expectedCategory) : false;
    const tenantLike = isTenantLikeResolvedType(item.details?.types);
    return distance <= 100 && (!item.valid || broad || !tenantLike);
  });
}

function canRelaxCategoryTypeCheck(
  expectedName: string,
  coords: Coordinates,
  expectedCategory: PlaceCategory | undefined,
  resolved: ResolvedIdentity,
): boolean {
  if (!expectedCategory || !resolved.name || !resolved.coords) return false;
  if (!["activity", "exhibition", "park", "nature"].includes(expectedCategory)) return false;
  if (!exactNameLikeMatch(expectedName, resolved.name)) return false;

  const distanceMeters = haversineDistanceMeters(coords, resolved.coords);
  return distanceMeters <= 25;
}

function canRelaxBroadPoiCheck(
  expectedName: string,
  coords: Coordinates,
  expectedCategory: PlaceCategory | undefined,
  resolved: ResolvedIdentity,
): boolean {
  if (!resolved.types || !resolved.name || !resolved.coords) return false;
  if (!categoryLooksLikeComplexOrBuilding(resolved.types)) return false;

  if (canRelaxCategoryTypeCheck(expectedName, coords, expectedCategory, resolved)) {
    return true;
  }

  if (!isTenantLikeCategory(expectedCategory)) return false;
  if (!namesLookCompatible(expectedName, resolved.name)) return false;

  const distanceMeters = haversineDistanceMeters(coords, resolved.coords);
  return distanceMeters <= 90;
}

function calcResolutionScore(
  candidate: ScoredCandidate,
  details: PlaceDetails,
  expectedName: string,
  coords: Coordinates,
  expectedAddress: string | undefined,
  expectedStructuredAddress: StructuredAddress | null,
  expectedPhone: string | undefined,
  expectedCategory: PlaceCategory | undefined,
): number {
  let score = candidate.baseScore;
  const exactNameMatched = !!details.resolvedName && exactNameLikeMatch(expectedName, details.resolvedName);
  const exactDistance = details.resolvedCoords
    ? haversineDistanceMeters(coords, details.resolvedCoords)
    : Infinity;

  const structuredAddressScore = compareStructuredAddress(
    expectedStructuredAddress,
    details.resolvedStructuredAddress,
  );
  if (structuredAddressScore > 0) {
    score += Math.max(0, structuredAddressScore - candidate.addressScore);
  } else {
    const resolvedAddressScore = calcAddressScore(details.resolvedAddress, expectedAddress);
    score += Math.max(0, resolvedAddressScore - candidate.addressScore);
  }

  const resolvedCategoryScore = calcCategoryScore(details.types, expectedCategory);
  score += Math.max(0, resolvedCategoryScore - candidate.categoryScore);

  score += calcPhoneScore(expectedPhone, details.resolvedPhone);

  if (!phonesLookCompatible(expectedPhone, details.resolvedPhone)) {
    if (exactNameMatched && exactDistance <= 90) {
      score += 8;
    } else {
      score -= 4;
    }
  }

  if (details.resolvedCoords) {
    if (exactDistance > PRIMARY_MATCH_MAX_DISTANCE_METERS) score -= 30;
    else if (exactDistance > 120) score -= 10;
    else if (
      exactDistance <= 40 &&
      isTenantLikeCategory(expectedCategory) &&
      isTenantLikeResolvedType(details.types)
    ) {
      score += 8;
    }
  }

  if (
    exactNameMatched &&
    exactDistance <= 90 &&
    categoryTypeCompatible(expectedCategory, details.types)
  ) {
    score += 10;
  }

  if (
    !categoryTypeCompatible(expectedCategory, details.types) &&
    !canRelaxCategoryTypeCheck(expectedName, coords, expectedCategory, {
      name: details.resolvedName,
      coords: details.resolvedCoords,
    })
  ) {
    score -= 10;
  }

  if (candidateLooksTooBroad(details, expectedName, expectedCategory)) {
    score -= 15;
  }

  return score;
}

async function resolvePlaceMatch(
  name: string,
  coords: Coordinates,
  address?: string,
  phone?: string,
  expectedCategory?: PlaceCategory,
): Promise<MatchResolution | null> {
  const kakaoStructuredAddress = await fetchKakaoStructuredAddress(coords, address);
  const scoredCandidates = await findPlaceIdScored(name, coords, address, expectedCategory);
  let hadNewApiCandidates = scoredCandidates.length > 0;
  let evaluated: Array<MatchResolution & { valid: boolean }> = [];

  if (scoredCandidates.length > 0) {
    const topCandidates = scoredCandidates.slice(0, 3);

    for (const candidate of topCandidates) {
      const details = await fetchPlaceDetails(candidate.id);
      const valid = validateResolvedIdentity(name, coords, address, kakaoStructuredAddress, phone, expectedCategory, {
        name: details.resolvedName,
        formattedAddress: details.resolvedAddress,
        phone: details.resolvedPhone,
        types: details.types,
        coords: details.resolvedCoords,
        structuredAddress: details.resolvedStructuredAddress,
      });
      const score = calcResolutionScore(
        candidate,
        details,
        name,
        coords,
        address,
        kakaoStructuredAddress,
        phone,
        expectedCategory,
      );

      evaluated.push({
        placeId: candidate.id,
        score,
        candidateName: details.resolvedName ?? candidate.displayName,
        details,
        valid,
      });
    }

    evaluated.sort((a, b) => b.score - a.score);
    const bestValid = evaluated.find((item) => item.valid);

    logger.info("googlePlaces", "후보 추가 검증", {
      name,
      top: evaluated
        .map((item) => `${item.candidateName}(${item.score}점${item.valid ? "" : "/invalid"})`)
        .join(" | "),
    });

    if (bestValid?.score && bestValid.score >= 90) {
      logger.info("googlePlaces", "자동 매칭 성공", {
        name,
        matched: bestValid.candidateName,
        score: bestValid.score,
      });
      return bestValid;
    }

    if (bestValid?.score && bestValid.score >= 75) {
      logger.warn("googlePlaces", "조건부 매칭 (75~89점)", {
        name,
        matched: bestValid.candidateName,
        score: bestValid.score,
      });
      return bestValid;
    }

    logger.warn("googlePlaces", "점수 기반 매칭 실패 (<75점)", {
      name,
      best: bestValid ? `${bestValid.candidateName}(${bestValid.score}점)` : "none",
    });
  }

  if (hadNewApiCandidates) {
    if (shouldTryLegacyFallbackForTenant(name, coords, expectedCategory, evaluated)) {
      logger.warn("googlePlaces", "legacy fallback 재허용", {
        name,
        reason: "복합몰 입점 매장 후보가 broad POI 위주로 판단됨",
      });
    } else {
    logger.warn("googlePlaces", "legacy fallback 생략", {
      name,
      reason: "New API 후보는 있었지만 점수 기준 미달",
    });
    return null;
    }
  }

  const fallbackId = await findPlaceId(name, coords, address, phone);
  if (!fallbackId) return null;
  const fallbackDetails = await fetchPlaceDetails(fallbackId);
  if (!validateResolvedIdentity(name, coords, address, kakaoStructuredAddress, phone, expectedCategory, {
    name: fallbackDetails.resolvedName,
    formattedAddress: fallbackDetails.resolvedAddress,
    phone: fallbackDetails.resolvedPhone,
    types: fallbackDetails.types,
    coords: fallbackDetails.resolvedCoords,
    structuredAddress: fallbackDetails.resolvedStructuredAddress,
  })) {
    logger.warn("googlePlaces", "legacy fallback 검증 실패", { name, placeId: fallbackId });
    return null;
  }

  logger.warn("googlePlaces", "legacy fallback 매칭 사용", {
    name,
    matched: fallbackDetails.resolvedName ?? fallbackId,
  });
  return {
    placeId: fallbackId,
    score: 0,
    candidateName: fallbackDetails.resolvedName ?? fallbackId,
    details: fallbackDetails,
  };
}

function validateResolvedIdentity(
  expectedName: string,
  coords: Coordinates,
  expectedAddress: string | undefined,
  expectedStructuredAddress: StructuredAddress | null,
  expectedPhone: string | undefined,
  expectedCategory: PlaceCategory | undefined,
  resolved: ResolvedIdentity,
): boolean {
  if (!resolved.name) return false;
  if (!namesLookCompatible(expectedName, resolved.name)) return false;

  if (!phonesLookCompatible(expectedPhone, resolved.phone)) {
    logger.info("googlePlaces", "후보 제외: 전화번호 불일치", {
      expected: expectedName,
      expectedPhone,
      resolvedPhone: resolved.phone ?? "-",
    });
  }
  if (resolved.coords) {
    const distanceMeters = haversineDistanceMeters(coords, resolved.coords);
    if (distanceMeters > PRIMARY_MATCH_MAX_DISTANCE_METERS) {
      logger.info("googlePlaces", "후보 제외: 상세 좌표 불일치", {
        expected: expectedName,
        resolved: resolved.name,
        distance: `${Math.round(distanceMeters)}m`,
      });
      return false;
    }
    const structuredCompatible = addressesStructuredLookCompatible(
      expectedStructuredAddress,
      resolved.structuredAddress,
    );
    if (
      !structuredCompatible &&
      !addressesLookCompatible(expectedAddress, resolved.formattedAddress, distanceMeters)
    ) {
      logger.info("googlePlaces", "후보 제외: 상세 주소 불일치", {
        expected: expectedName,
        expectedAddress,
        resolvedAddress: resolved.formattedAddress ?? "-",
      });
      return false;
    }
  }
  if (
    !categoryTypeCompatible(expectedCategory, resolved.types) &&
    !canRelaxCategoryTypeCheck(expectedName, coords, expectedCategory, resolved)
  ) {
    logger.info("googlePlaces", "후보 제외: 상세 타입 불일치", {
      expected: expectedName,
      category: expectedCategory,
      types: resolved.types?.join(",") ?? "-",
    });
    return false;
  }
  if (
    expectedCategory &&
    expectedCategory !== "mall" &&
    categoryLooksLikeComplexOrBuilding(resolved.types ?? []) &&
    !categoryTypeCompatible(expectedCategory, resolved.types) &&
    !canRelaxBroadPoiCheck(expectedName, coords, expectedCategory, resolved)
  ) {
    logger.info("googlePlaces", "후보 제외: 복합몰/건물 POI로 판단", {
      expected: expectedName,
      category: expectedCategory,
      types: resolved.types?.join(",") ?? "-",
    });
    return false;
  }
  return true;
}

function isValidCandidate(
  candidate: FindPlaceCandidate,
  expectedName: string,
  coords: Coordinates,
  expectedAddress?: string
): boolean {
  if (!candidate.name || !candidate.geometry?.location) return false;

  if (!namesLookCompatible(expectedName, candidate.name)) return false;

  const distanceMeters = haversineDistanceMeters(coords, {
    lat: candidate.geometry.location.lat,
    lng: candidate.geometry.location.lng,
  });
  if (distanceMeters > PRIMARY_MATCH_MAX_DISTANCE_METERS) {
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
    "name",
    "formatted_address",
    "address_component",
    "formatted_phone_number",
    "international_phone_number",
    "geometry",
    "types",
    "opening_hours",
    "current_opening_hours",
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
      name?: string;
      formatted_address?: string;
      address_components?: GoogleAddressComponent[];
      formatted_phone_number?: string;
      international_phone_number?: string;
      geometry?: { location?: { lat: number; lng: number } };
      types?: string[];
      opening_hours?: { open_now: boolean; periods: Period[]; weekday_text?: string[] };
      current_opening_hours?: {
        open_now?: boolean;
        periods?: Period[];
        weekday_text?: string[];
        special_days?: SpecialDay[];
      };
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

  const hoursSource = result.current_opening_hours ?? result.opening_hours;
  const hours: PlaceHours | null = hoursSource
    ? buildHoursFromPeriods(hoursSource.periods ?? [], hoursSource.open_now)
    : null;
  const hoursLabel = currentWeekdayTextLabel(result.current_opening_hours?.weekday_text)
    ?? currentWeekdayTextLabel(result.opening_hours?.weekday_text)
    ?? (hours ? formatOperatingHoursLabel(hours) : undefined);
  const hoursMayDiffer = result.current_opening_hours?.special_days?.some((day) => day.exceptional_hours === true) ?? false;

  // 대표 사진 URL 생성 (maxwidth=400)
  const photoRef = result.photos?.[0]?.photo_reference ?? null;
  const photoUrl = photoRef
    ? `https://maps.googleapis.com/maps/api/place/photo?maxwidth=400&photo_reference=${photoRef}&key=${GOOGLE_KEY}`
    : null;

  return {
    hours,
    hoursLabel,
    hoursMayDiffer,
    rating: result.rating ?? null,
    reviewCount: result.user_ratings_total ?? null,
    priceLevel: (result.price_level as 0 | 1 | 2 | 3 | 4 | undefined) ?? null,
    photoUrl,
    resolvedName: result.name,
    resolvedAddress: result.formatted_address,
    resolvedPhone: result.international_phone_number ?? result.formatted_phone_number ?? null,
    types: result.types ?? [],
    resolvedCoords: result.geometry?.location ? {
      lat: result.geometry.location.lat,
      lng: result.geometry.location.lng,
    } : undefined,
    resolvedStructuredAddress: parseGoogleStructuredAddress(result.address_components, result.formatted_address) ?? undefined,
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
  phone?: string,
  expectedCategory?: PlaceCategory,
): Promise<PlaceDetails | null> {
  if (!GOOGLE_KEY) return null;

  const key = `${name}|${address ?? ""}|${coords.lat.toFixed(4)},${coords.lng.toFixed(4)}`;
  const cached = cache.get(key);
  if (cached && Date.now() < cached.expiresAt) return detailsFromCache(cached);

  try {
    const match = await resolvePlaceMatch(name, coords, address, phone, expectedCategory);
    if (!match) {
      logger.warn("googlePlaces", "검증 가능한 place_id를 찾지 못함", { name });
      return null;
    }

    const placeId = match.placeId;
    const details = match.details ?? await fetchPlaceDetails(placeId);
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
  phone?: string,
  expectedCategory?: PlaceCategory,
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
      requestKind: intentBadges || "기본",
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
    const match = cached?.placeId
      ? { placeId: cached.placeId, details: undefined }
      : await resolvePlaceMatch(name, coords, address, phone, expectedCategory);
    const placeId = match?.placeId ?? null;
    if (!placeId) {
      logger.warn("googlePlaces", "atmosphere 조회용 place_id를 찾지 못함", { name });
      return null;
    }

    if (!cached?.placeId && match?.details) {
      cache.set(key, {
        placeId,
        rating: cached?.rating ?? match.details.rating ?? null,
        reviewCount: cached?.reviewCount ?? match.details.reviewCount ?? null,
        priceLevel: cached?.priceLevel ?? match.details.priceLevel ?? null,
        photoUrl: cached?.photoUrl ?? match.details.photoUrl ?? null,
        periods: cached?.periods ?? match.details.hours?.periods ?? [],
        hasParking: cached?.hasParking,
        parkingSummary: cached?.parkingSummary ?? null,
        goodForChildren: cached?.goodForChildren,
        menuForChildren: cached?.menuForChildren,
        goodForGroups: cached?.goodForGroups,
        restroom: cached?.restroom,
        expiresAt: Date.now() + CACHE_TTL_MS,
      });
    }

    const intentBadges = [
      options.children ? "🧒 아이동반" : null,
      options.parking ? "🚗 주차" : null,
      options.groups ? "👥 단체" : null,
    ].filter(Boolean).join(" + ");
    logger.info("placesNew", "조회 시작", {
      name,
      placeId,
      requestKind: intentBadges || "기본",
    });

    const placeScopedKey = `${placeId}|${fieldMask}`;
    const placeScopedCached = atmosphereCache.get(placeScopedKey);
    if (placeScopedCached && Date.now() < placeScopedCached.expiresAt && hasAtmosphereFields(placeScopedCached.details, options)) {
      logger.info("placesNew", "♻️ placeId 캐시 HIT", {
        name,
        placeId,
        requestKind: intentBadges || "기본",
      });
      const mergedCache: CacheEntry = {
        placeId,
        rating: cached?.rating ?? null,
        reviewCount: cached?.reviewCount ?? null,
        priceLevel: cached?.priceLevel ?? null,
        photoUrl: cached?.photoUrl ?? null,
        periods: cached?.periods ?? [],
        hasParking: placeScopedCached.details.hasParking ?? cached?.hasParking,
        parkingSummary: placeScopedCached.details.parkingSummary ?? cached?.parkingSummary ?? null,
        goodForChildren: placeScopedCached.details.goodForChildren ?? cached?.goodForChildren,
        menuForChildren: placeScopedCached.details.menuForChildren ?? cached?.menuForChildren,
        goodForGroups: placeScopedCached.details.goodForGroups ?? cached?.goodForGroups,
        restroom: placeScopedCached.details.restroom ?? cached?.restroom,
        expiresAt: Date.now() + CACHE_TTL_MS,
      };
      cache.set(key, mergedCache);
      return placeScopedCached.details;
    }

    let atmospherePromise = atmosphereInFlight.get(placeScopedKey);
    if (!atmospherePromise) {
      atmospherePromise = fetchPlaceAtmosphere(placeId, options).finally(() => {
        atmosphereInFlight.delete(placeScopedKey);
      });
      atmosphereInFlight.set(placeScopedKey, atmospherePromise);
    } else {
      logger.info("placesNew", "⏳ 동일 placeId 조회 재사용", {
        name,
        placeId,
        requestKind: intentBadges || "기본",
      });
    }

    const atmosphere = await atmospherePromise;
    atmosphereCache.set(placeScopedKey, {
      details: atmosphere,
      expiresAt: Date.now() + CACHE_TTL_MS,
    });
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
      requestKind: intentBadges || "기본",
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
