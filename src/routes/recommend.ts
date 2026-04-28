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
} from "../services/kakaoLocal";
import { formatOperatingHoursLabel, getPlaceDetails, isOpenAtOffset } from "../services/googlePlaces";
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
import type { Coordinates, Place, PlaceCategory, PlaceGroup } from "../types";

const router = Router();
const PLACE_CATEGORY_ORDER: PlaceCategory[] = [
  "cafe",
  "restaurant",
  "shopping",
  "popup",
  "exhibition",
  "park",
  "bar",
  "photo",
  "nature",
  "cinema",
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
        const details = await getPlaceDetails(place.name, place.coordinates, place.address);
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

const CATEGORY_TITLE: Record<PlaceCategory, string> = {
  cafe: "카페",
  restaurant: "맛집",
  shopping: "소품샵/쇼핑",
  popup: "팝업/행사",
  exhibition: "전시/문화",
  park: "공원 산책",
  bar: "바/이자카야",
  photo: "포토부스",
  nature: "자연",
  cinema: "영화관",
};

function buildPlaceGroups(scoredPlaces: Place[]): PlaceGroup[] {
  return PLACE_CATEGORY_ORDER.map((category) => ({
    category,
    title: CATEGORY_TITLE[category],
    places: scoredPlaces
      .filter((place) => place.category === category)
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
      .slice(0, 4),
  })).filter((group) => group.places.length > 0);
}

function mergeUniqueTags(tags: string[]): string[] {
  return [...new Set(tags)];
}

// ── Layer 1: 장소 풀 캐시 (위치 격자 기반, 2시간) ────────────────
interface PlacePool {
  cafes: Place[]; restaurants: Place[]; shoppingPlaces: Place[];
  kakaoParks: Place[]; photoBooths: Place[]; bars: Place[];
  naturePlaces: Place[]; cinemas: Place[]; kakaoPopups: Place[];
  popularPlaces: Place[]; kakaoTouristSpots: Place[]; kakaoCultureVenues: Place[];
  tourAttractions: Place[]; tourCulture: Place[]; tourFestivals: Place[];
  seoulPopups: Place[]; seoulParks: Place[];
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
  };

  const hasKakaoKey = !!process.env.KAKAO_REST_API_KEY;
  const hasTourKey = !!process.env.TOUR_API_KEY;
  const hasGoogleKey = !!process.env.GOOGLE_PLACES_API_KEY;

  console.log(`\n[recommend] 요청: lat=${lat}, lng=${lng}, 시간=${hour}시`);
  console.log(`[recommend] 지역: ${seoul ? "서울" : "서울 외"}`);
  console.log(`[recommend] Kakao:${hasKakaoKey ? "✅" : "❌"} Tour:${hasTourKey ? "✅" : "❌"} Google:${hasGoogleKey ? "✅" : "❌"}`);

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
      console.log(`[recommend] 장소 풀 캐시 HIT (${pKey})`);
      pool = cachedPool.pool;
    } else {
      console.log(`[recommend] 장소 풀 캐시 MISS → API 수집`);
      const [
        cafes, restaurants, shoppingPlaces, kakaoParks,
        photoBooths, bars, naturePlaces, cinemas,
        kakaoPopups, popularPlaces, kakaoTouristSpots, kakaoCultureVenues,
        tourAttractions, tourCulture, tourFestivals,
        seoulPopups, seoulParks,
      ] = await Promise.all([
        hasKakaoKey ? getNearByCafes(coords) : Promise.resolve(getMockCafes(coords)),
        hasKakaoKey ? getNearByRestaurants(coords) : Promise.resolve([]),
        hasKakaoKey ? getNearByShoppingPlaces(coords) : Promise.resolve(getMockShoppingPlaces(coords)),
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
      ]);

      pool = {
        cafes, restaurants, shoppingPlaces, kakaoParks,
        photoBooths, bars, naturePlaces, cinemas,
        kakaoPopups, popularPlaces, kakaoTouristSpots, kakaoCultureVenues,
        tourAttractions, tourCulture, tourFestivals,
        seoulPopups, seoulParks,
      };
      placePoolCache.set(pKey, { pool, expiresAt: Date.now() + POOL_TTL_MS });
    }

    const {
      cafes, restaurants, shoppingPlaces, kakaoParks,
      photoBooths, bars, naturePlaces, cinemas,
      kakaoPopups, popularPlaces, kakaoTouristSpots, kakaoCultureVenues,
      tourAttractions, tourCulture, tourFestivals,
      seoulPopups, seoulParks,
    } = pool;

    console.log(`[recommend] 날씨: ${weather.description} ${weather.temp}°C (체감 ${weather.feelsLike}°C) → ${getWeatherCondition(weather)}`);

    // ── 팝업/행사: 공공/관광 API 우선, 부족할 때만 카카오 보충 ──
    const primaryPopups = deduplicatePlaces([...seoulPopups, ...tourFestivals]);
    const rawPopups = preferPrimaryPlaces(primaryPopups, kakaoPopups, 8);

    // ── 공원: 카카오(키워드) + Tour API 관광지 + 서울시 공원 + 카카오 관광명소 ──
    const rawParks = deduplicatePlaces([...kakaoParks, ...tourAttractions, ...seoulParks, ...kakaoTouristSpots]);

    // ── 전시/문화: 공공 문화시설 우선, 부족할 때 카카오 문화시설 보충 ──
    const curatedCulture = preferPrimaryPlaces(tourCulture, kakaoCultureVenues, 8);

    const taggedPopularPlaces = popularPlaces.map((place) => ({
      ...place,
      tags: mergeUniqueTags(["카맵 랭킹", ...place.tags]),
    }));

    const allPlaces: Place[] = deduplicatePlaces([
      ...taggedPopularPlaces,
      ...cafes,
      ...restaurants,
      ...shoppingPlaces,
      ...rawPopups,
      ...rawParks,
      ...curatedCulture,
      ...photoBooths,
      ...bars,
      ...naturePlaces,
      ...cinemas,
    ]);

    console.log(
      `[recommend] 수집: 카페${cafes.length} 맛집${restaurants.length} 쇼핑${shoppingPlaces.length}` +
      ` 팝업${rawPopups.length}(공공${primaryPopups.length}/카카오${kakaoPopups.length}) 공원${rawParks.length} 문화${curatedCulture.length}` +
      ` 포토${photoBooths.length} 바${bars.length} 자연${naturePlaces.length} 영화관${cinemas.length}`
    );

    // ── Google Places 보강: 가까운 후보 + 인기 후보를 함께 enrich ─────────
    const nearbyFirst = [...allPlaces].sort((a, b) => a.walkingMinutes - b.walkingMinutes).slice(0, 25);
    const googleCandidates = [...new Map(
      [...nearbyFirst, ...taggedPopularPlaces].map((place) => [place.id, place] as const)
    ).values()];
    const enrichedCandidates = hasGoogleKey ? await enrichWithGoogleDetails(googleCandidates) : googleCandidates;
    const enrichedById = new Map(enrichedCandidates.map((p) => [p.id, p]));
    const enrichedPlaces = allPlaces.map((p) => enrichedById.get(p.id) ?? p);

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
      },
    };
    const scoredPlaces = enrichedPlaces.map((p) => ({
      ...p,
      score: scorePlace(p, ctx),
    }));

    // ── 코스 조합 (forecast로 동적 날씨 반영) ────────────────────
    const courses = buildCourses(scoredPlaces, weather, hour, options, forecast);

    // ── 인기 코스 생성 (accuracy 정렬 장소 기반) ─────────────────
    const popularIds = new Set(taggedPopularPlaces.map((place) => place.id));
    const enrichedPopularPlaces = enrichedPlaces.filter((place) => popularIds.has(place.id));
    if (enrichedPopularPlaces.length >= 2) {
      const scoredPopular = enrichedPopularPlaces.map((p) => ({ ...p, score: scorePlace(p, ctx) }));
      const popularCourse = buildCourses(scoredPopular, weather, hour, options, forecast);
      const best = popularCourse[0];
      if (best && !courses.some((c) => c.places.every((p, i) => p.id === best.places[i]?.id))) {
        courses.unshift({
          ...best,
          id: "course-popular",
          title: "🔥 사람들이 많이 찾는 코스",
          tags: mergeUniqueTags(["카맵 랭킹", "인기", ...best.tags]),
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
      console.log(`[recommend] AI 요약 캐시 HIT`);
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
      .slice(0, 12);
    const placeGroups = buildPlaceGroups(finalPlaces);

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
    console.log(`[recommend] 첫 코스 장소 Google 데이터: ${sample ?? "없음"}`);

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
    console.error("[recommend] 오류:", err);
    res.status(500).json({ error: "추천을 불러오지 못했어요" });
  }
});

export default router;
