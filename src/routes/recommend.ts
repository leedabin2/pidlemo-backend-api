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
import { getPlaceDetails, isOpenAtOffset } from "../services/googlePlaces";
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

async function enrichWithGoogleDetails(places: Place[]): Promise<Place[]> {
  if (!process.env.GOOGLE_PLACES_API_KEY) return places;

  return Promise.all(
    places.map(async (place) => {
      try {
        const details = await getPlaceDetails(place.name, place.coordinates);
        if (!details) return place;

        const { hours, rating, reviewCount, priceLevel, photoUrl } = details;
        const openAtArrival = hours ? isOpenAtOffset(hours, place.walkingMinutes) : null;

        return {
          ...place,
          isOpen: hours ? hours.isOpenNow : place.isOpen,
          googleRating: rating ?? undefined,
          googleReviewCount: reviewCount ?? undefined,
          priceLevel: priceLevel ?? undefined,
          photoUrl: photoUrl ?? undefined,
          tags: [
            ...place.tags,
            ...(hours?.closesAtMinutesFromNow !== null && (hours?.closesAtMinutesFromNow ?? Infinity) <= 30
              ? ["곧 마감"]
              : []),
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
    // ── 병렬 데이터 수집 ────────────────────────────────────────
    const [
      weather,
      forecast,
      cafes,
      restaurants,
      shoppingPlaces,
      kakaoParks,
      photoBooths,
      bars,
      naturePlaces,
      cinemas,
      kakaoPopups,
      popularPlaces,
      kakaoTouristSpots,
      kakaoCultureVenues,
      tourAttractions,
      tourCulture,
      tourFestivals,
      seoulPopups,
      seoulParks,
    ] = await Promise.all([
      getWeather(coords),
      getWeatherForecast(coords),

      // 카페/맛집/쇼핑/공원: 카카오 (전국)
      hasKakaoKey ? getNearByCafes(coords) : Promise.resolve(getMockCafes(coords)),
      hasKakaoKey ? getNearByRestaurants(coords) : Promise.resolve([]),
      hasKakaoKey ? getNearByShoppingPlaces(coords) : Promise.resolve(getMockShoppingPlaces(coords)),
      hasKakaoKey ? getKakaoParks(coords) : Promise.resolve(getMockKakaoParks(coords)),

      // 신규 카테고리: 카카오 (전국)
      hasKakaoKey ? getNearByPhotoBooth(coords) : Promise.resolve([]),
      hasKakaoKey ? getNearByBars(coords) : Promise.resolve([]),
      hasKakaoKey ? getNearByNaturePlaces(coords) : Promise.resolve([]),
      hasKakaoKey ? getNearByCinemas(coords) : Promise.resolve([]),
      // 카카오 키워드 팝업/행사
      hasKakaoKey ? getNearByKakaoPopups(coords) : Promise.resolve([]),
      // 인기순(accuracy) 장소 — 인기 코스 전용
      hasKakaoKey ? getNearByPopularPlaces(coords) : Promise.resolve([]),
      // 관광명소(AT4) + 문화시설(갤러리/미술관/박물관)
      hasKakaoKey ? getNearByTouristSpots(coords) : Promise.resolve([]),
      hasKakaoKey ? getNearByCultureVenues(coords) : Promise.resolve([]),

      // 관광지/문화/행사: Tour API (전국)
      hasTourKey ? getTourAttractions(coords) : Promise.resolve(getMockAttractions(coords)),
      hasTourKey ? getTourCulture(coords) : Promise.resolve([]),
      hasTourKey ? getTourFestivals(coords) : Promise.resolve(getMockFestivals(coords)),

      // 서울 한정
      seoul && process.env.PUBLIC_DATA_API_KEY ? getSeoulPopups(coords) : Promise.resolve(seoul ? getSeoulMockPopups(coords) : []),
      seoul && process.env.PUBLIC_DATA_API_KEY ? getSeoulParks(coords) : Promise.resolve(seoul ? getSeoulMockParks(coords) : []),
    ]);

    console.log(`[recommend] 날씨: ${weather.description} ${weather.temp}°C (체감 ${weather.feelsLike}°C) → ${getWeatherCondition(weather)}`);

    // ── 팝업/행사 병합: 카카오 키워드 + Tour API + 서울 공공API ──
    const rawPopups = deduplicatePlaces([...kakaoPopups, ...tourFestivals, ...seoulPopups]);

    // ── 공원: 카카오(키워드) + Tour API 관광지 + 서울시 공원 + 카카오 관광명소 ──
    const rawParks = deduplicatePlaces([...kakaoParks, ...tourAttractions, ...seoulParks, ...kakaoTouristSpots]);

    const allPlaces: Place[] = deduplicatePlaces([
      ...cafes,
      ...restaurants,
      ...shoppingPlaces,
      ...rawPopups,
      ...rawParks,
      ...tourCulture,
      ...kakaoCultureVenues, // 갤러리·미술관·박물관
      ...photoBooths,
      ...bars,
      ...naturePlaces,
      ...cinemas,
    ]);

    console.log(
      `[recommend] 수집: 카페${cafes.length} 맛집${restaurants.length} 쇼핑${shoppingPlaces.length}` +
      ` 팝업${rawPopups.length}(카카오${kakaoPopups.length}) 공원${rawParks.length} 문화${tourCulture.length}` +
      ` 포토${photoBooths.length} 바${bars.length} 자연${naturePlaces.length} 영화관${cinemas.length}`
    );

    // ── Google Places 보강: 가까운 25개만 미리 enrich → 별점이 스코어링에 반영됨 ──
    const nearbyFirst = [...allPlaces].sort((a, b) => a.walkingMinutes - b.walkingMinutes).slice(0, 25);
    const enrichedTop = hasGoogleKey ? await enrichWithGoogleDetails(nearbyFirst) : nearbyFirst;
    const enrichedById = new Map(enrichedTop.map((p) => [p.id, p]));
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
    if (popularPlaces.length >= 2) {
      const scoredPopular = popularPlaces.map((p) => ({ ...p, score: scorePlace(p, ctx) }));
      const popularCourse = buildCourses(scoredPopular, weather, hour, options, forecast);
      const best = popularCourse[0];
      if (best && !courses.some((c) => c.places.every((p, i) => p.id === best.places[i]?.id))) {
        courses.unshift({
          ...best,
          id: "course-popular",
          title: "🔥 사람들이 많이 찾는 코스",
          tags: ["인기", ...best.tags],
          isPopular: true,
        });
      }
    }

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
      courses,
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
