import { Router } from "express";
import type { Request, Response } from "express";
import { ipRateLimit } from "../middleware/rateLimit";
import { getWeather, getWeatherForecast } from "../services/weather";
import {
  getNearByCafes,
  getNearByRestaurants,
  getMockCafes,
  getNearByShoppingPlaces,
  getMockShoppingPlaces,
  getNearByMallPlaces,
  getMockMallPlaces,
  getNearByParks as getKakaoParks,
  getMockKakaoParks,
  getNearByWellnessPlaces,
  getMockWellnessPlaces,
  getNearByPhotoBooth,
  getNearByBars,
  getNearByNaturePlaces,
  getNearByCinemas,
  getNearByKakaoPopups,
  getNearByPopularPlaces,
  getNearByTouristSpots,
  getNearByCultureVenues,
  getNearByActivityPlaces,
} from "../services/kakaoLocal";
import { formatOperatingHoursLabel, getPlaceAtmosphere, getPlaceDetails, isOpenAtOffset } from "../services/googlePlaces";
import {
  getNearByPopups as getSeoulPopups,
  getMockPopups as getSeoulMockPopups,
  getNearByParks as getSeoulParks,
  getMockParks as getSeoulMockParks,
} from "../services/publicData";
import {
  getTourAttractions,
  getTourCulture,
  getTourFestivals,
  getMockAttractions,
  getMockFestivals,
} from "../services/tourApi";
import {
  buildCourses,
  getWeatherCondition,
  scorePlace,
  type RecommendationOptions,
} from "../utils/scoring";
import { isSeoul, isKorea, deduplicatePlaces } from "../utils/region";
import { generateCourseSummaries } from "../services/aiSummary";
import { logQuotaUsageSnapshot } from "../services/quotaTracker";
import { logger } from "../utils/logger";
import type { Coordinates, Place, PlaceCategory, PlaceGroup } from "../types";

const router = Router();
const PLACE_CATEGORY_ORDER: PlaceCategory[] = [
  "cafe",
  "restaurant",
  "shopping",
  "mall",
  "popup",
  "exhibition",
  "park",
  "bar",
  "photo",
  "nature",
  "cinema",
  "activity",
];

function parseCategories(value: unknown): PlaceCategory[] {
  if (typeof value !== "string" || !value.trim()) return [];
  const validCategories = new Set<PlaceCategory>(PLACE_CATEGORY_ORDER);
  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item): item is PlaceCategory => validCategories.has(item as PlaceCategory));
}

function preferPrimaryPlaces(primary: Place[], fallback: Place[], limit: number): Place[] {
  const primaryDeduped = deduplicatePlaces(primary).slice(0, limit);
  if (primaryDeduped.length >= limit) return primaryDeduped;

  const seen = new Set(primaryDeduped.map((place) => place.name.slice(0, 5).trim()));
  const supplemental = fallback.filter((place) => {
    const key = place.name.slice(0, 5).trim();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return [...primaryDeduped, ...supplemental].slice(0, limit);
}

// 오늘 같은 요일에 영업 주기가 2개 이상 있는지 확인 (브레이크타임 장소 감지)
function hasBreakTime(hours: import("../services/googlePlaces").PlaceHours): boolean {
  const today = new Date().getDay();
  const todayOpenCount = hours.periods.filter((p) => p.open.day === today).length;
  return todayOpenCount >= 2;
}

async function enrichWithGoogleDetails(places: Place[]): Promise<Place[]> {
  if (!process.env.GOOGLE_PLACES_API_KEY) return places;

  return Promise.all(
    places.map(async (place) => {
      try {
        const details = await getPlaceDetails(place.name, place.coordinates, place.address, place.phone);
        if (!details) return place;

        const { hours, rating, reviewCount, priceLevel, photoUrl } = details;
        const openAtArrival = hours ? isOpenAtOffset(hours, place.walkingMinutes) : null;
        const closingSoon = hours?.closesAtMinutesFromNow !== null && (hours?.closesAtMinutesFromNow ?? Infinity) <= 30;
        const breakTime = closingSoon && hours ? hasBreakTime(hours) : false;

        return {
          ...place,
          operatingHours: hours ? formatOperatingHoursLabel(hours) : place.operatingHours,
          isOpen: hours ? hours.isOpenNow : place.isOpen,
          googleRating: rating ?? undefined,
          googleReviewCount: reviewCount ?? undefined,
          priceLevel: priceLevel ?? undefined,
          photoUrl: photoUrl ?? undefined,
          googleHours: hours ?? undefined,
          tags: [
            ...place.tags,
            ...(breakTime ? ["브레이크타임"] : closingSoon ? ["곧 마감"] : []),
            ...(openAtArrival === false ? ["도착 시 마감"] : []),
          ],
        };
      } catch {
        return place;
      }
    })
  );
}

function shouldFetchAtmosphere(options: RecommendationOptions) {
  return (
    options.transport === "차량" ||
    options.companion === "아이와 함께" ||
    options.companion === "가족과" ||
    options.companion === "직장모임"
  );
}

function pickAtmosphereTargets(places: Place[], options: RecommendationOptions): Place[] {
  const picked: Place[] = [];
  const seen = new Set<string>();

  const addTop = (source: Place[], limit: number) => {
    for (const place of source) {
      if (picked.length >= 12) break;
      if (seen.has(place.id)) continue;
      seen.add(place.id);
      picked.push(place);
      if (limit > 0) limit -= 1;
      if (limit === 0) break;
    }
  };

  const byStage = [...places].sort((a, b) => candidateStageScore(b) - candidateStageScore(a));

  if (options.transport === "차량") {
    addTop(byStage.filter((p) => ["restaurant", "cafe", "shopping", "mall", "cinema", "activity"].includes(p.category)), 3);
  }
  if (options.companion === "아이와 함께" || options.companion === "가족과") {
    addTop(byStage.filter((p) => ["mall", "park", "exhibition", "activity", "cinema", "restaurant", "cafe"].includes(p.category)), 4);
  }
  if (options.companion === "직장모임") {
    addTop(byStage.filter((p) => ["restaurant", "bar", "cafe"].includes(p.category)), 4);
  }

  return picked;
}

async function enrichWithGoogleAtmosphere(
  places: Place[],
  options: RecommendationOptions
): Promise<Place[]> {
  if (!process.env.GOOGLE_PLACES_API_KEY || !shouldFetchAtmosphere(options)) return places;

  const targets = pickAtmosphereTargets(places, options);
  if (targets.length === 0) return places;

  logger.info("recommend", "Places API (New) atmosphere 대상 선정", {
    count: targets.length,
    transport: options.transport,
    companion: options.companion,
  });
  logger.list(
    "placesNew",
    `🎯 atmosphere 대상 ${targets.length}개`,
    targets.map((place) => {
      const badges = [
        options.transport === "차량" ? "🚗" : null,
        options.companion === "아이와 함께" || options.companion === "가족과" ? "🧒" : null,
        options.companion === "직장모임" ? "👥" : null,
      ].filter(Boolean).join("");
      return `${badges} ${place.name}(${place.category})`;
    }),
    12
  );

  const byId = new Map<string, Place>(places.map((place) => [place.id, place]));

  await Promise.all(
    targets.map(async (place) => {
      const atmosphere = await getPlaceAtmosphere(
        place.name,
        place.coordinates,
        {
          parking: options.transport === "차량",
          children: options.companion === "아이와 함께" || options.companion === "가족과",
          groups: options.companion === "직장모임",
        },
        place.address,
        place.phone
      );

      if (!atmosphere) return;

      const current = byId.get(place.id);
      if (!current) return;

      byId.set(place.id, {
        ...current,
        hasParking: atmosphere.hasParking ?? current.hasParking,
        parkingSummary: atmosphere.parkingSummary ?? current.parkingSummary,
        goodForChildren: atmosphere.goodForChildren ?? current.goodForChildren,
        menuForChildren: atmosphere.menuForChildren ?? current.menuForChildren,
        goodForGroups: atmosphere.goodForGroups ?? current.goodForGroups,
        restroom: atmosphere.restroom ?? current.restroom,
        tags: mergeUniqueTags([
          ...(atmosphere.hasParking ? ["주차 가능"] : []),
          ...(atmosphere.goodForChildren || atmosphere.menuForChildren ? ["아이 동반"] : []),
          ...(atmosphere.goodForGroups ? ["단체 모임"] : []),
          ...current.tags,
        ]),
      });
    })
  );

  return places.map((place) => byId.get(place.id) ?? place);
}

function parseEnvironment(value: unknown): RecommendationOptions["environment"] {
  if (value === "실내") return "실내";
  if (value === "실외" || value === "야외") return "야외";
  return "상관없음";
}

function parseWeatherAware(value: unknown): boolean {
  if (value === "false") return false;
  if (value === "0") return false;
  return true;
}

function parseTransport(value: unknown): "도보" | "대중교통" | "차량" {
  if (value === "대중교통") return "대중교통";
  if (value === "차량") return "차량";
  return "도보";
}

function parseCompanion(value: unknown): RecommendationOptions["companion"] {
  if (
    value === "아이와 함께" ||
    value === "데이트" ||
    value === "친구들과" ||
    value === "직장모임" ||
    value === "가족과"
  ) {
    return value;
  }
  return "상관없음";
}

const CATEGORY_TITLE: Record<PlaceCategory, string> = {
  cafe: "카페",
  restaurant: "맛집",
  shopping: "감성 소품샵",
  mall: "쇼핑몰",
  popup: "팝업/행사",
  exhibition: "전시/문화",
  park: "공원 산책",
  bar: "바/이자카야",
  photo: "포토부스",
  nature: "자연",
  cinema: "영화관",
  activity: "액티비티",
};
const POPULAR_CANDIDATE_TAG = "주변 인기 후보";
const CATEGORY_CANDIDATE_LIMIT: Record<PlaceCategory, number> = {
  cafe: 8,
  restaurant: 8,
  shopping: 6,
  mall: 5,
  popup: 6,
  exhibition: 6,
  park: 5,
  bar: 6,
  photo: 6,
  nature: 5,
  cinema: 4,
  activity: 6,
};

function buildPlaceGroups(scoredPlaces: Place[]): PlaceGroup[] {
  return PLACE_CATEGORY_ORDER.map((category) => ({
    category,
    title: CATEGORY_TITLE[category],
    places: scoredPlaces
      .filter((place) => place.category === category)
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
      .slice(0, 6),
  })).filter((group) => group.places.length > 0);
}

function mergeUniqueTags(tags: string[]): string[] {
  return [...new Set(tags)];
}

function hasGoogleCandidateSignal(place: Place): boolean {
  return (
    place.googleReviewCount !== undefined ||
    place.googleRating !== undefined ||
    place.googleHours !== undefined ||
    place.priceLevel !== undefined ||
    place.photoUrl !== undefined
  );
}

function getWeightedGoogleRating(place: Place): number | null {
  if (place.googleRating === undefined || place.googleReviewCount === undefined || place.googleReviewCount <= 0) {
    return null;
  }

  const priorMean = 4.2;
  const priorWeight = 50;
  return (
    (place.googleReviewCount / (place.googleReviewCount + priorWeight)) * place.googleRating +
    (priorWeight / (place.googleReviewCount + priorWeight)) * priorMean
  );
}

function candidateStageScore(place: Place): number {
  let score = 0;
  const reviewCount = place.googleReviewCount ?? 0;
  const weightedRating = getWeightedGoogleRating(place);

  if (place.category === "cafe" || place.category === "restaurant") {
    score += Math.min(55, Math.round(Math.log10(reviewCount + 1) * 18));
    score += weightedRating ? Math.max(0, Math.round((weightedRating - 3.8) * 24)) : 0;
    if (hasGoogleCandidateSignal(place)) score += 6;
  } else if (hasGoogleCandidateSignal(place)) {
    score += 6;
  }

  if (place.tags.includes(POPULAR_CANDIDATE_TAG) || place.tags.includes("인기")) {
    score += place.category === "cafe" || place.category === "restaurant" ? 14 : 9;
  }

  if (place.tags.includes("명소")) score += 6;
  if (place.tags.includes("도착 시 마감")) score -= 18;
  if (place.tags.includes("곧 마감") || place.tags.includes("브레이크타임")) score -= 8;

  if (place.isOpen === true) score += 8;
  if (place.isOpen === false) score -= 30;
  if (place.isOpen === null) score -= 4;

  if (place.walkingMinutes <= 10) score += 6;
  else if (place.walkingMinutes <= 20) score += 4;
  else if (place.walkingMinutes <= 30) score += 2;

  return score;
}

function selectCandidatePlaces(places: Place[]): Place[] {
  const result: Place[] = [];

  for (const category of PLACE_CATEGORY_ORDER) {
    const categoryPlaces = places.filter((place) => place.category === category);
    const limit = CATEGORY_CANDIDATE_LIMIT[category];
    const sorter = (a: Place, b: Place) => {
      const scoreDiff = candidateStageScore(b) - candidateStageScore(a);
      if (scoreDiff !== 0) return scoreDiff;
      return a.walkingMinutes - b.walkingMinutes;
    };

    const matched = categoryPlaces.filter(hasGoogleCandidateSignal).sort(sorter);
    const unmatched = categoryPlaces.filter((place) => !hasGoogleCandidateSignal(place)).sort(sorter);

    const selected = [...matched.slice(0, limit)];
    if (selected.length < limit) {
      selected.push(...unmatched.slice(0, limit - selected.length));
    }

    if (category === "restaurant") {
      const debugPool = [...matched, ...unmatched]
        .sort(sorter)
        .slice(0, 15);
      const formatCandidate = (place: Place, index: number) => {
          const weightedRating = getWeightedGoogleRating(place);
          return `${index + 1}.${place.name}(점수 ${candidateStageScore(place)} / 리뷰 ${place.googleReviewCount ?? "-"} / 보정 ${weightedRating ? weightedRating.toFixed(2) : "-"} / 영업 ${place.isOpen === true ? "Y" : place.isOpen === false ? "N" : "?"} / 인기 ${place.tags.includes(POPULAR_CANDIDATE_TAG) ? "Y" : "N"} / 구글 ${hasGoogleCandidateSignal(place) ? "Y" : "N"})`;
        };

      const selectedLog = debugPool
        .filter((place) => selected.some((item) => item.id === place.id))
        .map(formatCandidate);
      const cutLog = debugPool
        .filter((place) => !selected.some((item) => item.id === place.id))
        .map(formatCandidate);

      logger.info("recommend", "맛집 후보 SELECTED", {
        items: selectedLog.join(" | "),
      });
      if (cutLog.length > 0) {
        logger.info("recommend", "맛집 후보 CUT", {
          items: cutLog.join(" | "),
        });
      }
    }

    result.push(...selected);
  }

  return result;
}

// ── Layer 1: 장소 풀 캐시 (위치 격자 기반, 2시간) ────────────────
interface PlacePool {
  cafes: Place[]; restaurants: Place[]; shoppingPlaces: Place[]; mallPlaces: Place[];
  kakaoParks: Place[]; photoBooths: Place[]; bars: Place[];
  naturePlaces: Place[]; cinemas: Place[]; kakaoPopups: Place[];
  popularPlaces: Place[]; kakaoTouristSpots: Place[]; kakaoCultureVenues: Place[];
  tourAttractions: Place[]; tourCulture: Place[]; tourFestivals: Place[];
  seoulPopups: Place[]; seoulParks: Place[];
  activityPlaces: Place[];
}
const placePoolCache = new Map<string, { pool: PlacePool; expiresAt: number }>();
const POOL_TTL_MS = 2 * 60 * 60 * 1000; // 2시간

function poolKey(coords: Coordinates, seoul: boolean): string {
  return `${coords.lat.toFixed(2)}_${coords.lng.toFixed(2)}_${seoul ? "s" : "n"}`;
}

// ── Layer 2: AI 요약 캐시 (코스 조합 기반, 4시간) ────────────────
const aiSummaryCache = new Map<string, { summaries: string[]; expiresAt: number }>();
const AI_TTL_MS = 4 * 60 * 60 * 1000; // 4시간

function aiKey(courses: import("../types").Course[], slot: string, condition: string): string {
  const ids = courses.map((c) => c.places.map((p) => p.id).join("+")).join("|");
  return `${ids}__${slot}__${condition}`;
}

router.get("/", ipRateLimit, async (req: Request, res: Response) => {
  const lat = parseFloat(req.query.lat as string);
  const lng = parseFloat(req.query.lng as string);

  if (isNaN(lat) || isNaN(lng)) {
    res.status(400).json({ error: "lat, lng 파라미터가 필요해요" });
    return;
  }

  const coords: Coordinates = { lat, lng };

  if (!isKorea(coords)) {
    res.status(422).json({ error: "현재 한국에서만 사용할 수 있어요 🇰🇷" });
    return;
  }
  const hour = new Date().getHours();
  const seoul = isSeoul(coords);
  const options: RecommendationOptions = {
    selectedCategories: parseCategories(req.query.categories),
    duration: typeof req.query.duration === "string" ? req.query.duration : undefined,
    environment: parseEnvironment(req.query.environment),
    weatherAware: parseWeatherAware(req.query.weatherAware),
    transport: parseTransport(req.query.transport),
    companion: parseCompanion(req.query.companion),
  };

  const hasKakaoKey = !!process.env.KAKAO_REST_API_KEY;
  const hasTourKey = !!process.env.TOUR_API_KEY;
  const hasGoogleKey = !!process.env.GOOGLE_PLACES_API_KEY;

  logger.info("recommend", "추천 요청", {
    lat,
    lng,
    hour,
    transport: options.transport,
    companion: options.companion,
    region: seoul ? "서울" : "서울 외",
    kakao: hasKakaoKey ? "Y" : "N",
    tour: hasTourKey ? "Y" : "N",
    google: hasGoogleKey ? "Y" : "N",
  });
  logQuotaUsageSnapshot("[quota][before]");

  try {
    // ── 날씨는 항상 실시간 (30분 내 변경 가능) ──────────────────
    const [weather, forecast] = await Promise.all([
      getWeather(coords),
      getWeatherForecast(coords),
    ]);

    // ── Layer 1: 장소 풀 캐시 체크 ───────────────────────────────
    const pKey = poolKey(coords, seoul);
    const cachedPool = placePoolCache.get(pKey);
    let pool: PlacePool;

    if (cachedPool && Date.now() < cachedPool.expiresAt) {
      logger.info("recommend", "장소 풀 캐시 HIT", { key: pKey });
      pool = cachedPool.pool;
    } else {
      logger.info("recommend", "장소 풀 캐시 MISS → API 수집", { key: pKey });
      const [
        cafes, restaurants, shoppingPlaces, mallPlaces, kakaoParks,
        photoBooths, bars, naturePlaces, cinemas,
        kakaoPopups, popularPlaces, kakaoTouristSpots, kakaoCultureVenues,
        tourAttractions, tourCulture, tourFestivals,
        seoulPopups, seoulParks, activityPlaces,
      ] = await Promise.all([
        hasKakaoKey ? getNearByCafes(coords) : Promise.resolve(getMockCafes(coords)),
        hasKakaoKey ? getNearByRestaurants(coords) : Promise.resolve([]),
        hasKakaoKey ? getNearByShoppingPlaces(coords) : Promise.resolve(getMockShoppingPlaces(coords)),
        hasKakaoKey ? getNearByMallPlaces(coords) : Promise.resolve(getMockMallPlaces(coords)),
        hasKakaoKey ? getKakaoParks(coords) : Promise.resolve(getMockKakaoParks(coords)),
        hasKakaoKey ? getNearByPhotoBooth(coords) : Promise.resolve([]),
        hasKakaoKey ? getNearByBars(coords) : Promise.resolve([]),
        hasKakaoKey ? getNearByNaturePlaces(coords) : Promise.resolve([]),
        hasKakaoKey ? getNearByCinemas(coords) : Promise.resolve([]),
        hasKakaoKey ? getNearByKakaoPopups(coords) : Promise.resolve([]),
        hasKakaoKey ? getNearByPopularPlaces(coords) : Promise.resolve([]),
        hasKakaoKey ? getNearByTouristSpots(coords) : Promise.resolve([]),
        hasKakaoKey ? getNearByCultureVenues(coords) : Promise.resolve([]),
        hasTourKey ? getTourAttractions(coords) : Promise.resolve(getMockAttractions(coords)),
        hasTourKey ? getTourCulture(coords) : Promise.resolve([]),
        hasTourKey ? getTourFestivals(coords) : Promise.resolve(getMockFestivals(coords)),
        seoul && process.env.PUBLIC_DATA_API_KEY ? getSeoulPopups(coords) : Promise.resolve(seoul ? getSeoulMockPopups(coords) : []),
        seoul && process.env.PUBLIC_DATA_API_KEY ? getSeoulParks(coords) : Promise.resolve(seoul ? getSeoulMockParks(coords) : []),
        hasKakaoKey ? getNearByActivityPlaces(coords) : Promise.resolve([]),
      ]);

      pool = {
        cafes, restaurants, shoppingPlaces, mallPlaces, kakaoParks,
        photoBooths, bars, naturePlaces, cinemas,
        kakaoPopups, popularPlaces, kakaoTouristSpots, kakaoCultureVenues,
        tourAttractions, tourCulture, tourFestivals,
        seoulPopups, seoulParks, activityPlaces,
      };
      placePoolCache.set(pKey, { pool, expiresAt: Date.now() + POOL_TTL_MS });
    }

    const {
      cafes, restaurants, shoppingPlaces, mallPlaces, kakaoParks,
      photoBooths, bars, naturePlaces, cinemas,
      kakaoPopups, popularPlaces, kakaoTouristSpots, kakaoCultureVenues,
      tourAttractions, tourCulture, tourFestivals,
      seoulPopups, seoulParks, activityPlaces,
    } = pool;

    logger.info("recommend", "날씨 요약", {
      weather: weather.description,
      temp: `${weather.temp}°C`,
      feelsLike: `${weather.feelsLike}°C`,
      condition: getWeatherCondition(weather),
    });

    // ── 팝업/행사: 공공/관광 API 우선, 부족할 때만 카카오 보충 ──
    const primaryPopups = deduplicatePlaces([...seoulPopups, ...tourFestivals]);
    const rawPopups = preferPrimaryPlaces(primaryPopups, kakaoPopups, 10);

    // ── 공원: 카카오(키워드) + Tour API 관광지 + 서울시 공원 + 카카오 관광명소 ──
    const rawParks = deduplicatePlaces([...kakaoParks, ...tourAttractions, ...seoulParks, ...kakaoTouristSpots]);

    // ── 전시/문화: 공공 문화시설 우선, 부족할 때 카카오 문화시설 보충 ──
    const curatedCulture = preferPrimaryPlaces(tourCulture, kakaoCultureVenues, 10);

    const taggedPopularPlaces = popularPlaces.map((place) => ({
      ...place,
      tags: mergeUniqueTags([POPULAR_CANDIDATE_TAG, ...place.tags]),
    }));

    const allPlaces: Place[] = deduplicatePlaces([
      ...taggedPopularPlaces,
      ...cafes,
      ...restaurants,
      ...shoppingPlaces,
      ...mallPlaces,
      ...rawPopups,
      ...rawParks,
      ...curatedCulture,
      ...photoBooths,
      ...bars,
      ...naturePlaces,
      ...cinemas,
      ...activityPlaces,
    ]);

    logger.info("recommend", "원천 수집 요약", {
      cafe: cafes.length,
      restaurant: restaurants.length,
      shopping: shoppingPlaces.length,
      mall: mallPlaces.length,
      popup: `${rawPopups.length}(공공${primaryPopups.length}/카카오${kakaoPopups.length})`,
      park: rawParks.length,
      exhibition: curatedCulture.length,
      photo: photoBooths.length,
      bar: bars.length,
      nature: naturePlaces.length,
      cinema: cinemas.length,
      activity: activityPlaces.length,
    });

    // ── Google Places 보강: 가까운 후보 + 인기 후보를 함께 enrich ─────────
    const nearbyFirst = [...allPlaces].sort((a, b) => a.walkingMinutes - b.walkingMinutes).slice(0, 40);
    const googleCandidates = [...new Map(
      [...nearbyFirst, ...taggedPopularPlaces].map((place) => [place.id, place] as const)
    ).values()];
    const enrichedCandidates = hasGoogleKey ? await enrichWithGoogleDetails(googleCandidates) : googleCandidates;
    const enrichedById = new Map(enrichedCandidates.map((p) => [p.id, p]));
    const enrichedPlaces = allPlaces.map((p) => enrichedById.get(p.id) ?? p);

    const restaurantSourcePool = enrichedPlaces
      .filter((place) => place.category === "restaurant")
      .sort((a, b) => {
        const popularDiff = Number(b.tags.includes(POPULAR_CANDIDATE_TAG)) - Number(a.tags.includes(POPULAR_CANDIDATE_TAG));
        if (popularDiff !== 0) return popularDiff;
        return a.walkingMinutes - b.walkingMinutes;
      })
      .slice(0, 15)
      .map((place) => `${place.name}${place.tags.includes(POPULAR_CANDIDATE_TAG) ? "(인기후보)" : ""}`);
    logger.list("recommend", `맛집 원천 후보 ${restaurantSourcePool.length}개`, restaurantSourcePool, 15);

    // ── 후보 선정: 카테고리별로 구글 매칭 성공 후보 우선 선별 ─────────
    const candidatePlacesBase = selectCandidatePlaces(enrichedPlaces);
    const candidatePlaces = await enrichWithGoogleAtmosphere(candidatePlacesBase, options);
    logger.info("recommend", "후보 선정 요약", {
      categories: PLACE_CATEGORY_ORDER.map((category) => (
        `${category}${candidatePlaces.filter((place) => place.category === category).length}`
      )).join(" "),
    });

    // ── 스코어 계산 (googleRating/reviewCount 포함) ──────────────
    const ctx = {
      weather,
      condition: getWeatherCondition(weather, options.weatherAware),
      hourOfDay: hour,
      preferences: {
        selectedCategories: options.selectedCategories ?? [],
        environment: options.environment ?? "상관없음",
        durationBudgetMinutes: null,
        weatherAware: options.weatherAware ?? true,
        transport: options.transport,
        companion: options.companion ?? "상관없음",
      },
    };
    const scoredPlaces = candidatePlaces.map((p) => ({
      ...p,
      score: scorePlace(p, ctx),
    }));

    // ── 코스 조합 (forecast로 동적 날씨 반영) ────────────────────
    const courses = buildCourses(scoredPlaces, weather, hour, options, forecast);

    // ── 인기 코스 생성 (accuracy 정렬 장소 기반) ─────────────────
    const popularIds = new Set(taggedPopularPlaces.map((place) => place.id));
    const enrichedPopularPlaces = candidatePlaces.filter((place) => popularIds.has(place.id));
    if (enrichedPopularPlaces.length >= 2) {
      const scoredPopular = enrichedPopularPlaces.map((p) => ({ ...p, score: scorePlace(p, ctx) }));
      const popularCourse = buildCourses(scoredPopular, weather, hour, options, forecast);
      const best = popularCourse[0];
      if (best && !courses.some((c) => c.places.every((p, i) => p.id === best.places[i]?.id))) {
        courses.unshift({
          ...best,
          id: "course-popular",
          title: "🔥 주변 인기 장소 코스",
          tags: mergeUniqueTags([POPULAR_CANDIDATE_TAG, "인기", ...best.tags]),
          isPopular: true,
        });
      }
    }

    // ── Layer 2: AI 요약 캐시 ────────────────────────────────────
    const condition = getWeatherCondition(weather, options.weatherAware);
    const slot = hour < 6 ? "dawn" : hour < 11 ? "morning" : hour < 14 ? "lunch" : hour < 17 ? "afternoon" : hour < 21 ? "evening" : "night";
    const aKey = aiKey(courses, slot, condition);
    const cachedAi = aiSummaryCache.get(aKey);

    let summaries: string[];
    if (cachedAi && Date.now() < cachedAi.expiresAt) {
      logger.info("recommend", "AI 요약 캐시 HIT");
      summaries = cachedAi.summaries;
    } else {
      summaries = await generateCourseSummaries(courses, weather, hour);
      aiSummaryCache.set(aKey, { summaries, expiresAt: Date.now() + AI_TTL_MS });
    }

    const coursesWithSummary = courses.map((c, i) => ({
      ...c,
      aiReason: summaries[i] || undefined,
    }));

    const finalPlaces = scoredPlaces;

    const topPlaces = [...finalPlaces]
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
      .slice(0, 18);
    const placeGroups = buildPlaceGroups(finalPlaces);
    logQuotaUsageSnapshot("[quota][after]");

    // ── 종일 비 감지 → 찜질방/웰니스 코스 추가 ──────────────────
    const allDayRain = weather.isRainy && forecast.every((e) => e.isRainy);
    if (allDayRain && courses.length < 5) {
      const wellnessPlaces = hasKakaoKey
        ? await getNearByWellnessPlaces(coords)
        : getMockWellnessPlaces(coords);

      if (wellnessPlaces.length > 0) {
        courses.push({
          id: `course-wellness`,
          title: "비 오는 날 실내 힐링 코스 추천!",
          durationMinutes: wellnessPlaces.reduce((acc, p) => acc + p.walkingMinutes + 90, 0),
          places: wellnessPlaces,
          tags: ["실내 전용", "우천 대안"],
          weatherHint: "종일 비 예보가 있어요. 따뜻하게 쉬다 오세요 ☔",
        });
      }
    }

    // ── 새벽 빈 결과 감지 ────────────────────────────────────────
    const isDawn = hour >= 0 && hour < 6;
    const confirmedOpenCount = scoredPlaces.filter((p) => p.isOpen === true).length;
    const emptyReason: string | null =
      isDawn && courses.length === 0 && confirmedOpenCount < 2
        ? "새벽이라 근처에서 운영 중인 곳이 없어요.\n24시간 공원이나 편의점을 찾아보세요."
        : null;

    // 응답 전 Google 데이터 확인 로그
    const sample = courses[0]?.places.slice(0, 3).map((p) =>
      `${p.name}(rating:${p.googleRating ?? "없음"},open:${p.isOpen})`
    ).join(" / ");
    logger.info("recommend", "첫 코스 Google 데이터", {
      sample: sample ?? "없음",
    });

    res.json({
      region: seoul ? "seoul" : "nationwide",
      weather: {
        description: weather.description,
        temp: weather.temp,
        feelsLike: weather.feelsLike,
        isSunny: weather.isSunny,
        isRainy: weather.isRainy,
      },
      courses: coursesWithSummary,
      places: topPlaces,
      placeGroups,
      emptyReason,
      remainingToday: res.locals.rateLimitRemaining as number | null,
    });
  } catch (err) {
    logger.error("recommend", "추천 처리 오류", {
      error: err instanceof Error ? err.message : String(err),
    });
    res.status(500).json({ error: "추천을 불러오지 못했어요" });
  }
});

export default router;
