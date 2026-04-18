import type { Place, WeatherInfo, Course } from "../types";

interface ScoreContext {
  weather: WeatherInfo;
  hourOfDay: number;
}

// 시간대 구분
function getTimeSlot(hour: number): "morning" | "afternoon" | "evening" | "night" {
  if (hour >= 7 && hour < 12) return "morning";
  if (hour >= 12 && hour < 17) return "afternoon";
  if (hour >= 17 && hour < 21) return "evening";
  return "night";
}

/**
 * 장소 점수 계산
 * 거리(40) + 날씨(30) + 시간(20) + 마감긴급도(10)
 */
export function scorePlace(place: Place, ctx: ScoreContext): number {
  let score = 0;
  const maxWalk = 30;
  score += Math.max(0, ((maxWalk - place.walkingMinutes) / maxWalk) * 40);
  score += weatherScore(place.category, ctx.weather);
  score += timeScore(place.category, ctx.hourOfDay);
  if (place.tags.some((t) => t.includes("마감") || t.includes("남음"))) {
    score += 10;
  }
  return Math.round(score);
}

function weatherScore(category: Place["category"], weather: WeatherInfo): number {
  if (weather.isRainy) {
    if (category === "cafe" || category === "exhibition") return 30;
    if (category === "popup" || category === "restaurant") return 20;
    if (category === "park") return 0;
  } else if (weather.isSunny) {
    if (category === "park") return 30;
    if (category === "cafe") return 25;
    if (category === "popup" || category === "restaurant") return 20;
    if (category === "exhibition") return 15;
  }
  return 15;
}

function timeScore(category: Place["category"], hour: number): number {
  const slot = getTimeSlot(hour);
  const scores: Record<Place["category"], Record<string, number>> = {
    cafe:       { morning: 20, afternoon: 20, evening: 10, night: 5 },
    restaurant: { morning: 5,  afternoon: 15, evening: 20, night: 15 },
    popup:      { morning: 10, afternoon: 20, evening: 15, night: 10 },
    exhibition: { morning: 10, afternoon: 20, evening: 15, night: 5 },
    park:       { morning: 15, afternoon: 20, evening: 15, night: 5 },
  };
  return scores[category]?.[slot] ?? 10;
}

/**
 * 시간대별 코스 순서 템플릿
 * 각 템플릿은 카테고리 순서를 정의 — 앞 순서일수록 먼저 방문
 */
const COURSE_TEMPLATES: Record<
  ReturnType<typeof getTimeSlot>,
  { order: Place["category"][]; label: string }[]
> = {
  morning: [
    { order: ["cafe", "park", "exhibition"], label: "오전 산책 코스" },
    { order: ["cafe", "popup", "exhibition"], label: "오전 문화 코스" },
  ],
  afternoon: [
    { order: ["cafe", "popup", "park"], label: "오후 여유 코스" },
    { order: ["exhibition", "cafe", "popup"], label: "오후 전시 코스" },
  ],
  evening: [
    { order: ["restaurant", "park", "cafe"], label: "저녁 산책 코스" },
    { order: ["restaurant", "popup", "cafe"], label: "저녁 팝업 코스" },
  ],
  night: [
    { order: ["restaurant", "popup"], label: "야간 코스" },
    { order: ["restaurant", "cafe"], label: "야간 카페 코스" },
  ],
};

/**
 * 템플릿 순서에 맞게 장소를 정렬
 * 점수가 높은 장소 중에서 카테고리가 맞는 것을 순서대로 선택
 */
function buildCourseFromTemplate(
  sorted: Place[],
  order: Place["category"][]
): Place[] {
  const result: Place[] = [];
  for (const cat of order) {
    const candidate = sorted.find(
      (p) => p.category === cat && !result.some((r) => r.id === p.id)
    );
    if (candidate) result.push(candidate);
  }
  return result;
}

export function buildCourses(
  scoredPlaces: Place[],
  weather: WeatherInfo,
  hour: number = new Date().getHours()
): Course[] {
  const STAY_TIME: Record<Place["category"], number> = {
    cafe: 60,
    popup: 45,
    exhibition: 60,
    park: 50,
    restaurant: 60,
  };

  const slot = getTimeSlot(hour);
  const templates = COURSE_TEMPLATES[slot];
  const sorted = [...scoredPlaces].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  const courses: Course[] = [];

  for (const tmpl of templates) {
    const places = buildCourseFromTemplate(sorted, tmpl.order);
    if (places.length < 2) continue;

    // 기존 코스와 장소 집합이 완전히 같으면 중복 제거
    const isDuplicate = courses.some((c) => {
      const cIds = new Set(c.places.map((p) => p.id));
      return places.every((p) => cIds.has(p.id));
    });
    if (isDuplicate) continue;

    const duration = places.reduce((s, p) => s + STAY_TIME[p.category], 0)
      + places.reduce((s, p) => s + p.walkingMinutes, 0);

    const tags = buildTags(weather, slot, places);

    courses.push({
      id: `course-${courses.length + 1}`,
      title: buildTitle(places, tmpl.label),
      durationMinutes: duration,
      places,
      tags,
    });

    if (courses.length >= 2) break;
  }

  // 템플릿으로 2개 못 만들면 점수 순 다양 조합으로 보충
  if (courses.length < 2) {
    const fallback = pickDiversePlaces(sorted, 3);
    if (
      fallback.length >= 2 &&
      !courses.some((c) => c.places.every((p) => fallback.some((f) => f.id === p.id)))
    ) {
      const duration = fallback.reduce((s, p) => s + STAY_TIME[p.category], 0)
        + fallback.reduce((s, p) => s + p.walkingMinutes, 0);
      courses.push({
        id: `course-${courses.length + 1}`,
        title: buildTitle(fallback, "추천 코스"),
        durationMinutes: duration,
        places: fallback,
        tags: buildTags(weather, slot, fallback),
      });
    }
  }

  return courses;
}

function buildTitle(places: Place[], fallback: string): string {
  const emojiMap: Record<string, string> = {
    cafe: "카페",
    popup: "팝업",
    exhibition: "전시",
    park: "공원 산책",
    restaurant: "맛집",
  };
  if (places.length < 2) return fallback;
  return places.map((p) => emojiMap[p.category] ?? p.name).join(" → ") + " 코스";
}

function buildTags(
  weather: WeatherInfo,
  slot: ReturnType<typeof getTimeSlot>,
  places: Place[]
): string[] {
  const tags: string[] = [];
  const slotLabel: Record<string, string> = {
    morning: "오전 추천",
    afternoon: "오후 추천",
    evening: "저녁 추천",
    night: "야간 추천",
  };
  tags.push(slotLabel[slot]);
  if (weather.isSunny) tags.push("맑음 최적");
  if (weather.isRainy) tags.push("실내 중심");
  if (places.some((p) => p.tags.includes("오늘 마감"))) tags.push("현재 진행중");
  return tags;
}

function pickDiversePlaces(places: Place[], count: number): Place[] {
  const result: Place[] = [];
  const usedCategories = new Set<string>();
  for (const place of places) {
    if (result.length >= count) break;
    if (!usedCategories.has(place.category)) {
      result.push(place);
      usedCategories.add(place.category);
    }
  }
  return result;
}
