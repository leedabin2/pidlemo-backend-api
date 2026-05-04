import type { Coordinates, Course, ForecastEntry, Place, WeatherInfo } from "../types";
import { isOpenAtOffset as isGoogleOpenAtOffset } from "../services/googlePlaces";
import { getOpenStateAtOffset } from "./openHours";

type WeatherCondition = "실내전용" | "실내선호" | "쾌적" | "야외최적";
type TimeSlot = "dawn" | "morning" | "lunch" | "afternoon" | "evening" | "night";
type EnvironmentPreference = "실내" | "야외" | "상관없음";
type CompanionPreference = "상관없음" | "아이와 함께" | "데이트" | "친구들과" | "직장모임" | "가족과";

interface CourseTemplate {
  categories: Place["category"][];
  title: string;
  intent: string;
  featured?: boolean;
}

export interface RecommendationOptions {
  selectedCategories?: Place["category"][];
  environment?: EnvironmentPreference;
  duration?: string;
  weatherAware?: boolean;
  transport?: "도보" | "대중교통" | "차량";
  companion?: CompanionPreference;
}

interface NormalizedOptions {
  selectedCategories: Place["category"][];
  environment: EnvironmentPreference;
  durationBudgetMinutes: number | null;
  weatherAware: boolean;
  transport?: "도보" | "대중교통" | "차량";
  companion: CompanionPreference;
}

interface ScoreContext {
  weather: WeatherInfo;
  condition: WeatherCondition;
  hourOfDay: number;
  preferences: NormalizedOptions;
}

const STAY_TIME: Record<Place["category"], number> = {
  cafe: 60,
  popup: 45,
  exhibition: 60,
  park: 50,
  restaurant: 65,
  shopping: 40,
  bar: 90,
  photo: 30,
  nature: 120,
  cinema: 130,
  activity: 90, // 만화카페·보드게임·방탈출 평균 체류
};

const CATEGORY_LABEL: Record<Place["category"], string> = {
  cafe: "카페",
  popup: "팝업",
  exhibition: "전시",
  park: "공원 산책",
  restaurant: "맛집",
  shopping: "소품샵",
  bar: "바/이자카야",
  photo: "포토부스",
  nature: "자연",
  cinema: "영화관",
  activity: "액티비티",
};

// 9~22시(morning/lunch/afternoon/evening)에 행사/팝업/전시 우선
const CATEGORY_ORDER_BY_SLOT: Record<TimeSlot, Place["category"][]> = {
  dawn:      ["park", "cafe", "exhibition", "shopping", "popup", "restaurant", "nature", "photo", "bar", "cinema", "activity"],
  morning:   ["popup", "exhibition", "cafe", "park", "shopping", "restaurant", "photo", "nature", "cinema", "bar", "activity"],
  lunch:     ["restaurant", "popup", "exhibition", "cafe", "shopping", "park", "photo", "cinema", "nature", "bar", "activity"],
  afternoon: ["popup", "exhibition", "shopping", "cafe", "park", "restaurant", "photo", "cinema", "activity", "nature", "bar"],
  evening:   ["restaurant", "activity", "popup", "exhibition", "bar", "shopping", "cafe", "park", "photo", "cinema", "nature"],
  night:     ["activity", "bar", "restaurant", "cafe", "cinema", "shopping", "popup", "exhibition", "photo", "nature", "park"],
};

const BASE_TEMPLATES: Record<TimeSlot, CourseTemplate[]> = {
  dawn: [
    { categories: ["park", "cafe"], title: "새벽 산책 코스 추천!", intent: "walk" },
    { categories: ["park"], title: "새벽 공원 산책 추천!", intent: "park-only" },
  ],
  morning: [
    { categories: ["cafe", "park", "exhibition"], title: "아침 산책 코스 추천!", intent: "walk" },
    { categories: ["cafe", "exhibition", "popup"], title: "느긋한 문화 코스 추천!", intent: "culture" },
    { categories: ["cafe", "nature", "restaurant"], title: "명소 둘러보는 오전 코스 추천!", intent: "landmark" },
    { categories: ["shopping", "cafe", "park"], title: "가볍게 둘러보는 오전 코스 추천!", intent: "browse" },
    { categories: ["cafe", "photo", "shopping"], title: "감성 오전 코스 추천!", intent: "photo" },
    { categories: ["exhibition", "cafe", "park"], title: "조용한 오전 코스 추천!", intent: "quiet" },
    { categories: ["cafe", "popup"], title: "가볍게 시작하는 코스 추천!", intent: "short" },
  ],
  lunch: [
    { categories: ["restaurant", "cafe", "popup"], title: "점심 후 둘러보기 코스 추천!", intent: "browse" },
    { categories: ["restaurant", "exhibition", "cafe"], title: "문화 충전 코스 추천!", intent: "culture" },
    { categories: ["restaurant", "exhibition", "park"], title: "놀거리 많은 점심 코스 추천!", intent: "play" },
    { categories: ["restaurant", "park", "cafe"], title: "식사 후 산책 코스 추천!", intent: "walk" },
    { categories: ["shopping", "restaurant", "cafe"], title: "소품샵 구경 코스 추천!", intent: "shopping" },
    { categories: ["restaurant", "photo", "cafe"], title: "맛집 후 감성 코스 추천!", intent: "photo" },
    { categories: ["activity", "restaurant", "popup"], title: "실내 놀거리 코스 추천!", intent: "activity" },
    { categories: ["restaurant", "cafe"], title: "짧고 깔끔한 점심 코스 추천!", intent: "short" },
  ],
  afternoon: [
    { categories: ["shopping", "cafe", "park"], title: "소품샵 구경 코스 추천!", intent: "shopping" },
    { categories: ["cafe", "popup", "park"], title: "가볍게 돌아다니는 코스 추천!", intent: "browse" },
    { categories: ["cafe", "exhibition", "nature"], title: "구경거리 많은 오후 코스 추천!", intent: "landmark" },
    { categories: ["activity", "exhibition", "popup"], title: "놀거리 많은 코스 추천!", intent: "activity" },
    { categories: ["park", "cafe", "restaurant"], title: "햇살 좋은 힐링 코스 추천!", intent: "healing" },
    { categories: ["cafe", "photo", "shopping"], title: "감성 오후 코스 추천!", intent: "photo" },
    { categories: ["cinema", "cafe"], title: "영화 데이트 코스 추천!", intent: "cinema" },
    { categories: ["popup", "cafe", "exhibition"], title: "트렌디한 오후 코스 추천!", intent: "trend" },
    { categories: ["cafe", "exhibition"], title: "차분한 실내 코스 추천!", intent: "quiet" },
  ],
  evening: [
    { categories: ["restaurant", "bar", "cafe"], title: "저녁 감성 코스 추천!", intent: "nightlife" },
    { categories: ["restaurant", "activity"], title: "식사 후 놀거리 코스 추천!", intent: "activity" },
    { categories: ["restaurant", "cafe", "park"], title: "테라스 감성 코스 추천!", intent: "terrace" },
    { categories: ["restaurant", "exhibition", "park"], title: "저녁 명소 코스 추천!", intent: "landmark" },
    { categories: ["restaurant", "park", "cafe"], title: "퇴근 후 힐링 코스 추천!", intent: "healing" },
    { categories: ["shopping", "restaurant", "cafe"], title: "소품샵 구경 코스 추천!", intent: "shopping" },
    { categories: ["restaurant", "activity", "popup"], title: "놀거리 많은 저녁 코스 추천!", intent: "play" },
    { categories: ["restaurant", "cinema"], title: "영화관 데이트 코스 추천!", intent: "cinema" },
    { categories: ["restaurant", "exhibition", "cafe"], title: "저녁 문화 코스 추천!", intent: "culture" },
    { categories: ["popup", "restaurant", "cafe"], title: "데이트 느낌 코스 추천!", intent: "trend" },
    { categories: ["restaurant", "cafe"], title: "퇴근 후 가볍게 코스 추천!", intent: "short" },
  ],
  night: [
    { categories: ["activity", "cafe"], title: "야간 실내 놀이 코스 추천!", intent: "activity" },
    { categories: ["restaurant", "activity"], title: "밤까지 즐기는 코스 추천!", intent: "play" },
    { categories: ["restaurant", "bar"], title: "술 한잔 코스 추천!", intent: "nightlife" },
    { categories: ["bar", "cafe"], title: "야간 감성 코스 추천!", intent: "healing" },
    { categories: ["restaurant", "cafe"], title: "늦은 시간 편한 코스 추천!", intent: "short" },
    { categories: ["cinema", "restaurant"], title: "심야 영화 코스 추천!", intent: "cinema" },
    { categories: ["shopping", "cafe"], title: "늦게까지 구경하는 코스 추천!", intent: "shopping" },
    { categories: ["restaurant", "exhibition"], title: "야간 실내 코스 추천!", intent: "culture" },
  ],
};

const PARK_FALLBACKS: Place["category"][] = ["exhibition", "popup", "shopping", "cafe", "cinema", "photo"];

function normalizeOptions(options?: RecommendationOptions): NormalizedOptions {
  const durationBudgetMinutes = (() => {
    switch (options?.duration) {
      case "1h":
        return 90;
      case "2h":
        return 150;
      case "3h":
        return 210;
      case "4h+":
      case "5h":
        return 300;
      default:
        return null;
    }
  })();

  return {
    selectedCategories: options?.selectedCategories ?? [],
    environment: options?.environment ?? "상관없음",
    durationBudgetMinutes,
    weatherAware: options?.weatherAware ?? true,
    transport: options?.transport,
    companion: options?.companion ?? "상관없음",
  };
}

function getDesiredStopCount(options: NormalizedOptions): number {
  if (!options.durationBudgetMinutes) return 3;
  if (options.durationBudgetMinutes <= 90) return 2;
  return 3;
}

function isIndoorCategory(category: Place["category"]): boolean {
  return category !== "park" && category !== "nature";
}

function calcTravelMinutes(from: Coordinates, to: Coordinates): number {
  const R = 6371000;
  const dLat = ((to.lat - from.lat) * Math.PI) / 180;
  const dLng = ((to.lng - from.lng) * Math.PI) / 180;
  const aa =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((from.lat * Math.PI) / 180) *
      Math.cos((to.lat * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  const meters = R * 2 * Math.atan2(Math.sqrt(aa), Math.sqrt(1 - aa));
  return Math.max(1, Math.round(meters / 80));
}

function dedupeTemplates(templates: CourseTemplate[]): CourseTemplate[] {
  const seen = new Set<string>();
  return templates.filter((template) => {
    const key = template.categories.join(",");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function getTimeSlot(hour: number): TimeSlot {
  if (hour >= 0 && hour < 6) return "dawn";
  if (hour >= 6 && hour < 11) return "morning";
  if (hour >= 11 && hour < 14) return "lunch";
  if (hour >= 14 && hour < 17) return "afternoon";
  if (hour >= 17 && hour < 21) return "evening";
  return "night";
}

export function getWeatherCondition(
  weather: WeatherInfo,
  weatherAware = true
): WeatherCondition {
  if (!weatherAware) return "쾌적";
  if (weather.isRainy) return "실내전용";
  const fl = weather.feelsLike;
  if (fl >= 33 || fl <= 5) return "실내전용";
  if (fl >= 28 || fl <= 12) return "실내선호";
  if (weather.isSunny && fl >= 18 && fl <= 27) return "야외최적";
  return "쾌적";
}

function buildFocusTemplates(
  slot: TimeSlot,
  options: NormalizedOptions
): CourseTemplate[] {
  return options.selectedCategories.map((category) => {
    const ordered = [
      category,
      ...CATEGORY_ORDER_BY_SLOT[slot].filter((item) => item !== category),
    ];
    return {
      categories: ordered.slice(0, getDesiredStopCount(options)),
      title: `${CATEGORY_LABEL[category]} 중심 코스 추천!`,
      intent: `focus-${category}`,
    };
  });
}

function buildCompanionTemplates(
  slot: TimeSlot,
  options: NormalizedOptions,
  condition: WeatherCondition
): CourseTemplate[] {
  const indoorSafe = condition === "실내전용" || condition === "실내선호";

  switch (options.companion) {
    case "아이와 함께":
      switch (slot) {
        case "morning":
          return indoorSafe
            ? [{ categories: ["activity", "cafe", "cinema"], title: "아이와 함께 실내 코스 추천!", intent: "kids-indoor" }]
            : [{ categories: ["park", "cafe", "activity"], title: "아이와 함께 가볍게 노는 코스 추천!", intent: "kids-play" }];
        case "lunch":
          return indoorSafe
            ? [{ categories: ["restaurant", "activity", "cafe"], title: "아이와 함께 실내 점심 코스 추천!", intent: "kids-lunch" }]
            : [{ categories: ["restaurant", "park", "cafe"], title: "아이와 함께 점심 산책 코스 추천!", intent: "kids-lunch" }];
        case "afternoon":
          return indoorSafe
            ? [
                { categories: ["activity", "cinema", "cafe"], title: "아이와 함께 실내 놀거리 코스 추천!", intent: "kids-play" },
                { categories: ["exhibition", "cafe", "shopping"], title: "아이와 함께 둘러보는 코스 추천!", intent: "kids-browse" },
              ]
            : [
                { categories: ["park", "activity", "cafe"], title: "아이와 함께 놀거리 코스 추천!", intent: "kids-play" },
                { categories: ["nature", "cafe", "restaurant"], title: "아이와 함께 바깥 나들이 코스 추천!", intent: "kids-outdoor" },
              ];
        case "evening":
          return indoorSafe
            ? [{ categories: ["restaurant", "cinema", "cafe"], title: "아이와 함께 저녁 실내 코스 추천!", intent: "kids-evening" }]
            : [{ categories: ["restaurant", "park", "cafe"], title: "아이와 함께 저녁 나들이 코스 추천!", intent: "kids-evening" }];
        case "night":
          return [{ categories: ["restaurant", "cinema"], title: "아이와 함께 편한 야간 코스 추천!", intent: "kids-night" }];
        default:
          return [];
      }

    case "데이트":
      switch (slot) {
        case "morning":
          return [{ categories: ["cafe", "park", "exhibition"], title: "데이트 산책 코스 추천!", intent: "date-walk" }];
        case "lunch":
          return [{ categories: ["restaurant", "cafe", "popup"], title: "데이트 점심 코스 추천!", intent: "date-lunch" }];
        case "afternoon":
          return [
            { categories: ["cafe", "exhibition", "photo"], title: "감성 데이트 코스 추천!", intent: "date-mood" },
            { categories: ["cinema", "cafe", "restaurant"], title: "영화 데이트 코스 추천!", intent: "date-cinema" },
            { categories: ["popup", "cafe", "park"], title: "구경거리 많은 데이트 코스 추천!", intent: "date-browse" },
          ];
        case "evening":
          return indoorSafe
            ? [
                { categories: ["restaurant", "cinema", "cafe"], title: "저녁 영화 데이트 코스 추천!", intent: "date-cinema" },
                { categories: ["restaurant", "exhibition", "cafe"], title: "저녁 데이트 코스 추천!", intent: "date-evening" },
              ]
            : [
                { categories: ["restaurant", "park", "cafe"], title: "저녁 산책 데이트 코스 추천!", intent: "date-evening" },
                { categories: ["restaurant", "cinema", "cafe"], title: "저녁 영화 데이트 코스 추천!", intent: "date-cinema" },
                { categories: ["restaurant", "bar", "cafe"], title: "분위기 좋은 데이트 코스 추천!", intent: "date-night" },
              ];
        case "night":
          return [
            { categories: ["bar", "cafe"], title: "야간 데이트 코스 추천!", intent: "date-night" },
            { categories: ["cinema", "restaurant"], title: "심야 데이트 코스 추천!", intent: "date-cinema" },
          ];
        default:
          return [];
      }

    case "친구들과":
      switch (slot) {
        case "lunch":
          return [{ categories: ["restaurant", "activity", "cafe"], title: "친구들과 놀기 좋은 점심 코스 추천!", intent: "friends-lunch" }];
        case "afternoon":
          return [
            { categories: ["activity", "cafe", "popup"], title: "친구들과 놀거리 코스 추천!", intent: "friends-play" },
            { categories: ["cinema", "restaurant", "cafe"], title: "친구들과 영화 코스 추천!", intent: "friends-cinema" },
          ];
        case "evening":
          return [
            { categories: ["restaurant", "activity", "bar"], title: "친구들과 저녁 놀거리 코스 추천!", intent: "friends-evening" },
            { categories: ["restaurant", "bar", "cafe"], title: "친구들과 모임 코스 추천!", intent: "friends-drink" },
          ];
        case "night":
          return [{ categories: ["activity", "bar"], title: "친구들과 야간 코스 추천!", intent: "friends-night" }];
        default:
          return [];
      }

    case "직장모임":
      switch (slot) {
        case "lunch":
          return [{ categories: ["restaurant", "cafe"], title: "직장모임 점심 코스 추천!", intent: "coworkers-lunch" }];
        case "afternoon":
          return [{ categories: ["cafe", "restaurant"], title: "가볍게 만나는 직장모임 코스 추천!", intent: "coworkers-light" }];
        case "evening":
          return [
            { categories: ["restaurant", "bar", "cafe"], title: "직장모임 저녁 코스 추천!", intent: "coworkers-evening" },
            { categories: ["restaurant", "cafe"], title: "편하게 끝나는 직장모임 코스 추천!", intent: "coworkers-short" },
          ];
        case "night":
          return [{ categories: ["restaurant", "bar"], title: "직장모임 야간 코스 추천!", intent: "coworkers-night" }];
        default:
          return [];
      }

    case "가족과":
      switch (slot) {
        case "morning":
          return indoorSafe
            ? [{ categories: ["exhibition", "cafe", "restaurant"], title: "가족과 실내 코스 추천!", intent: "family-indoor" }]
            : [{ categories: ["park", "cafe", "restaurant"], title: "가족과 오전 나들이 코스 추천!", intent: "family-outing" }];
        case "lunch":
          return [
            { categories: ["restaurant", "park", "cafe"], title: "가족과 점심 나들이 코스 추천!", intent: "family-lunch" },
            { categories: ["restaurant", "exhibition", "cafe"], title: "가족과 문화 코스 추천!", intent: "family-culture" },
          ];
        case "afternoon":
          return indoorSafe
            ? [{ categories: ["exhibition", "shopping", "cafe"], title: "가족과 실내 구경 코스 추천!", intent: "family-browse" }]
            : [{ categories: ["park", "cafe", "exhibition"], title: "가족과 오후 나들이 코스 추천!", intent: "family-outing" }];
        case "evening":
          return [
            { categories: ["restaurant", "park", "cafe"], title: "가족과 저녁 산책 코스 추천!", intent: "family-evening" },
            { categories: ["restaurant", "cinema", "cafe"], title: "가족과 저녁 실내 코스 추천!", intent: "family-cinema" },
          ];
        case "night":
          return [{ categories: ["restaurant", "cafe"], title: "가족과 편한 야간 코스 추천!", intent: "family-night" }];
        default:
          return [];
      }

    default:
      return [];
  }
}

function buildFeaturedTemplates(
  slot: TimeSlot,
  condition: WeatherCondition
): CourseTemplate[] {
  const title =
    condition === "실내전용" || condition === "실내선호"
      ? "지금 어울리는 실내 코스 추천!"
      : "지금 어울리는 코스 추천!";

  switch (slot) {
    case "dawn":
      return [{ categories: ["park", "cafe"], title, intent: "featured", featured: true }];
    case "morning":
      if (condition === "야외최적") {
        return [{ categories: ["cafe", "park", "exhibition"], title, intent: "featured", featured: true }];
      }
      return [{ categories: ["cafe", "exhibition", "shopping"], title, intent: "featured", featured: true }];
    case "lunch":
      if (condition === "야외최적") {
        return [{ categories: ["restaurant", "park", "cafe"], title, intent: "featured", featured: true }];
      }
      if (condition === "실내전용" || condition === "실내선호") {
        return [{ categories: ["restaurant", "exhibition", "cafe"], title, intent: "featured", featured: true }];
      }
      return [{ categories: ["restaurant", "cafe", "popup"], title, intent: "featured", featured: true }];
    case "afternoon":
      if (condition === "야외최적") {
        return [{ categories: ["shopping", "cafe", "park"], title, intent: "featured", featured: true }];
      }
      if (condition === "실내전용" || condition === "실내선호") {
        return [{ categories: ["exhibition", "cafe", "shopping"], title, intent: "featured", featured: true }];
      }
      return [{ categories: ["popup", "cafe", "exhibition"], title, intent: "featured", featured: true }];
    case "evening":
      if (condition === "야외최적") {
        return [{ categories: ["restaurant", "park", "cafe"], title, intent: "featured", featured: true }];
      }
      if (condition === "실내전용" || condition === "실내선호") {
        return [{ categories: ["restaurant", "activity", "cafe"], title, intent: "featured", featured: true }];
      }
      return [{ categories: ["restaurant", "activity", "popup"], title, intent: "featured", featured: true }];
    case "night":
      if (condition === "실내전용" || condition === "실내선호") {
        return [{ categories: ["activity", "bar"], title, intent: "featured", featured: true }];
      }
      return [{ categories: ["restaurant", "bar"], title, intent: "featured", featured: true }];
  }
}

function buildConditionTemplates(
  slot: TimeSlot,
  condition: WeatherCondition
): CourseTemplate[] {
  if (condition === "야외최적") {
    if (slot === "evening") {
      return [
        { categories: ["cafe", "restaurant", "park"], title: "테라스 감성 코스 추천!", intent: "terrace" },
        { categories: ["shopping", "restaurant", "cafe"], title: "소품샵 구경 코스 추천!", intent: "shopping" },
        { categories: ["restaurant", "park", "cafe"], title: "퇴근 후 힐링 코스 추천!", intent: "healing" },
      ];
    }

    if (slot === "afternoon") {
      return [
        { categories: ["shopping", "cafe", "park"], title: "햇살 좋은 산책 코스 추천!", intent: "walk" },
        { categories: ["popup", "cafe", "park"], title: "놀거리 많은 코스 추천!", intent: "browse" },
      ];
    }
  }

  if (condition === "실내전용") {
    // 실제 비/폭염/혹한 → activity 코스 적극 추천
    if (slot === "evening" || slot === "night") {
      return [
        { categories: ["restaurant", "activity"], title: "비 오는 날 실내 놀이 코스 추천!", intent: "activity" },
        { categories: ["shopping", "restaurant", "cafe"], title: "비 오는 날 실내 코스 추천!", intent: "shopping" },
        { categories: ["restaurant", "exhibition", "cafe"], title: "저녁 문화 코스 추천!", intent: "culture" },
      ];
    }
    return [
      { categories: ["activity", "cafe"], title: "비 오는 날 실내 액티비티 코스 추천!", intent: "activity" },
      { categories: ["exhibition", "cafe", "shopping"], title: "비 오는 날 실내 코스 추천!", intent: "culture" },
      { categories: ["shopping", "cafe", "popup"], title: "실내 구경 코스 추천!", intent: "shopping" },
    ];
  }

  if (condition === "실내선호") {
    // 약간 덥거나 추운 날 → 실내 위주지만 activity 제목에 비 언급 X
    if (slot === "evening") {
      return [
        { categories: ["shopping", "restaurant", "cafe"], title: "실내 위주 저녁 코스 추천!", intent: "shopping" },
        { categories: ["restaurant", "exhibition", "cafe"], title: "저녁 문화 코스 추천!", intent: "culture" },
      ];
    }
    return [
      { categories: ["exhibition", "cafe", "shopping"], title: "실내에서 쉬기 좋은 코스 추천!", intent: "quiet" },
      { categories: ["shopping", "cafe", "popup"], title: "실내 구경 코스 추천!", intent: "shopping" },
    ];
  }

  return [];
}

function swapParkForIndoor(template: Place["category"][]): Place["category"][] {
  const used = new Set<Place["category"]>();
  return template.map((category) => {
    if (category !== "park") {
      used.add(category);
      return category;
    }

    const fallback = PARK_FALLBACKS.find((item) => !used.has(item));
    const replacement = fallback ?? "cafe";
    used.add(replacement);
    return replacement;
  });
}

function applyPreferencesToTemplate(
  template: CourseTemplate,
  condition: WeatherCondition,
  options: NormalizedOptions
): CourseTemplate {
  let adjusted = [...template.categories];

  if (
    condition === "실내전용" ||
    condition === "실내선호" ||
    options.environment === "실내"
  ) {
    adjusted = swapParkForIndoor(adjusted);
  }

  if (options.environment === "야외" && condition !== "실내전용") {
    if (!adjusted.includes("park")) {
      adjusted[adjusted.length - 1] = "park";
    }
  }

  for (const category of options.selectedCategories) {
    if (adjusted.includes(category)) continue;
    adjusted = [category, ...adjusted.filter((item) => item !== category)];
  }

  const deduped: Place["category"][] = [];
  for (const category of adjusted) {
    if (!deduped.includes(category)) deduped.push(category);
  }

  let title = template.title;
  if ((condition === "실내전용" || condition === "실내선호") && title.includes("힐링")) {
    title = "비 오는 날 실내 코스 추천!";
  }
  if ((condition === "실내전용" || condition === "실내선호") && title.includes("햇살")) {
    title = "실내에서 쉬기 좋은 코스 추천!";
  }

  return {
    ...template,
    title,
    categories: deduped.slice(0, getDesiredStopCount(options)),
  };
}

function weatherScore(category: Place["category"], condition: WeatherCondition): number {
  const table: Record<WeatherCondition, Partial<Record<Place["category"], number>>> = {
    야외최적: { park: 32, cafe: 25, popup: 22, restaurant: 20, exhibition: 15, shopping: 18, nature: 35, bar: 10, photo: 18, cinema: 12, activity: 10 },
    쾌적:    { park: 24, cafe: 22, popup: 22, restaurant: 20, exhibition: 20, shopping: 20, nature: 26, bar: 16, photo: 20, cinema: 18, activity: 18 },
    실내선호: { cafe: 28, exhibition: 28, popup: 24, restaurant: 22, park: 5, shopping: 27, nature: 5, bar: 22, photo: 24, cinema: 28, activity: 28 },
    실내전용: { cafe: 30, exhibition: 30, popup: 25, restaurant: 24, park: 0, shopping: 28, nature: 0, bar: 24, photo: 26, cinema: 30, activity: 32 },
  };
  return table[condition][category] ?? 15;
}

function timeScore(category: Place["category"], slot: TimeSlot): number {
  // popup/exhibition: 9~22시(morning~evening) 집중 부스트
  const table: Record<Place["category"], Record<TimeSlot, number>> = {
    cafe:       { dawn: 2,  morning: 20, lunch: 12, afternoon: 20, evening: 12, night: 8  },
    restaurant: { dawn: 0,  morning: 5,  lunch: 22, afternoon: 14, evening: 22, night: 16 },
    popup:      { dawn: 0,  morning: 20, lunch: 22, afternoon: 24, evening: 22, night: 10 },
    exhibition: { dawn: 0,  morning: 20, lunch: 22, afternoon: 24, evening: 20, night: 6  },
    park:       { dawn: 20, morning: 18, lunch: 14, afternoon: 20, evening: 16, night: 5  },
    shopping:   { dawn: 0,  morning: 10, lunch: 14, afternoon: 22, evening: 18, night: 10 },
    bar:        { dawn: 5,  morning: 0,  lunch: 0,  afternoon: 5,  evening: 22, night: 30 },
    photo:      { dawn: 0,  morning: 14, lunch: 18, afternoon: 22, evening: 20, night: 14 },
    nature:     { dawn: 18, morning: 22, lunch: 16, afternoon: 18, evening: 14, night: 2  },
    cinema:     { dawn: 0,  morning: 10, lunch: 14, afternoon: 22, evening: 20, night: 18 },
    // 저녁·야간·비오는날 특화. 오전엔 거의 비추천
    activity:   { dawn: 4,  morning: 8,  lunch: 12, afternoon: 18, evening: 26, night: 30 },
  };
  return table[category]?.[slot] ?? 10;
}

function companionScore(
  category: Place["category"],
  companion: CompanionPreference,
  slot: TimeSlot
): number {
  if (companion === "상관없음") return 0;

  const table: Record<Exclude<CompanionPreference, "상관없음">, Partial<Record<Place["category"], number>>> = {
    "아이와 함께": {
      restaurant: 8, cafe: 6, popup: 2, exhibition: 10, park: 12, shopping: 4,
      bar: -22, photo: 2, nature: 8, cinema: 12, activity: 14,
    },
    데이트: {
      restaurant: 8, cafe: 12, popup: 8, exhibition: 10, park: 8, shopping: 6,
      bar: 6, photo: 10, nature: 6, cinema: 12, activity: 3,
    },
    "친구들과": {
      restaurant: 8, cafe: 4, popup: 3, exhibition: 2, park: 6, shopping: 4,
      bar: 10, photo: 4, nature: 8, cinema: 8, activity: 14,
    },
    직장모임: {
      restaurant: 14, cafe: 8, popup: 2, exhibition: -2, park: -6, shopping: 2,
      bar: 12, photo: -6, nature: -8, cinema: -4, activity: 0,
    },
    가족과: {
      restaurant: 12, cafe: 6, popup: 4, exhibition: 8, park: 10, shopping: 4,
      bar: -18, photo: 2, nature: 8, cinema: 8, activity: 6,
    },
  };

  let score = table[companion][category] ?? 0;
  if (companion === "아이와 함께" && (slot === "night" || slot === "dawn")) {
    if (category === "bar") score -= 6;
    if (category === "park" || category === "nature") score -= 8;
  }
  if (companion === "직장모임" && (slot === "evening" || slot === "night")) {
    if (category === "restaurant" || category === "bar") score += 4;
  }
  if (companion === "데이트" && slot === "evening") {
    if (category === "park" || category === "bar" || category === "photo" || category === "cinema") score += 3;
  }
  return score;
}

function companionPlaceHeuristicScore(
  place: Place,
  companion: CompanionPreference,
  slot: TimeSlot
): number {
  if (companion === "상관없음") return 0;

  let score = 0;

  if (companion === "데이트") {
    if (place.category === "cinema" && (slot === "afternoon" || slot === "evening" || slot === "night")) {
      score += 8;
    }
    if (place.category === "cafe" && place.googleRating && place.googleRating >= 4.3) {
      score += 2;
    }
  }

  if (companion === "직장모임") {
    // 아직 goodForGroups를 안 받고 있으므로,
    // 식당/바/카페 + 후기 수 + 짧은 이동을 단체 친화적인 임시 신호로 사용.
    if (place.category === "restaurant" || place.category === "bar" || place.category === "cafe") {
      score += 4;
      if ((place.googleReviewCount ?? 0) >= 300) score += 6;
      else if ((place.googleReviewCount ?? 0) >= 100) score += 3;
      if (place.walkingMinutes <= 10) score += 3;
    }

    if (place.goodForGroups) score += 12;

    if (place.category === "park" || place.category === "nature" || place.category === "photo") {
      score -= 6;
    }

    if (slot === "evening" || slot === "night") {
      if (place.category === "restaurant" || place.category === "bar") score += 4;
    }
  }

  if (companion === "아이와 함께" || companion === "가족과") {
    if (place.goodForChildren) score += 8;
    if (place.menuForChildren) score += 4;
    if (place.restroom) score += 2;
  }

  return score;
}

function transportScore(place: Place, transport: NormalizedOptions["transport"]): number {
  if (transport !== "차량") return 0;
  if (place.hasParking) return 10;
  if (place.parkingSummary) return 6;
  return 0;
}

function preferenceScore(category: Place["category"], options: NormalizedOptions, slot: TimeSlot): number {
  let score = 0;

  if (options.selectedCategories.includes(category)) {
    score += 16;
  }

  if (options.environment === "실내") {
    score += isIndoorCategory(category) ? 8 : -14;
  }

  if (options.environment === "야외") {
    score += category === "park" ? 12 : -4;
  }

  score += companionScore(category, options.companion, slot);

  return score;
}

// 예보 엔트리에서 날씨 조건 계산
function conditionFromForecast(entry: ForecastEntry): WeatherCondition {
  if (entry.isRainy) return "실내전용";
  const fl = entry.feelsLike;
  if (fl >= 33 || fl <= 5) return "실내전용";
  if (fl >= 28 || fl <= 12) return "실내선호";
  if (entry.isSunny && fl >= 18 && fl <= 27) return "야외최적";
  return "쾌적";
}

// 도착 예정 시간(elapsedMinutes 후)의 날씨 조건 반환
function getConditionAtOffset(
  base: WeatherCondition,
  elapsedMinutes: number,
  forecast: ForecastEntry[] | undefined
): WeatherCondition {
  if (!forecast?.length) return base;
  const offsetHours = elapsedMinutes / 60;
  const entry = forecast.reduce((prev, curr) =>
    Math.abs(curr.offsetHours - offsetHours) < Math.abs(prev.offsetHours - offsetHours)
      ? curr
      : prev
  );
  // 예보가 4시간 이상 벗어나면 현재 날씨 사용
  if (Math.abs(entry.offsetHours - offsetHours) > 4) return base;
  return conditionFromForecast(entry);
}

function ratingScore(place: Place): number {
  // 카페/맛집만 별점·리뷰 수 반영
  if (place.category !== "cafe" && place.category !== "restaurant") return 0;

  const { googleRating, googleReviewCount } = place;
  if (googleRating === undefined || googleReviewCount === undefined || googleReviewCount <= 0) {
    return 0;
  }

  // 리뷰 수가 적을수록 전체 평균 쪽으로 당기는 베이지안 보정
  const priorMean = 4.2;
  const priorWeight = 50;
  const weightedRating =
    (googleReviewCount / (googleReviewCount + priorWeight)) * googleRating +
    (priorWeight / (googleReviewCount + priorWeight)) * priorMean;

  // 리뷰 수는 별도 보너스가 아니라 신뢰도로 사용
  const confidence = Math.min(1, Math.log10(googleReviewCount + 1) / 2);
  const baseScore = Math.max(-6, Math.min(18, (weightedRating - 3.8) * 12));
  let score = baseScore * confidence;

  if (googleReviewCount >= 500) {
    score += 4;
  } else if (googleReviewCount >= 100) {
    score += 2;
  }

  // 리뷰가 너무 적으면 사실상 참고 수준으로만 반영
  if (googleReviewCount < 5) {
    score = Math.min(score, 2);
  }

  return Math.round(score);
}

function popularityScore(place: Place): number {
  if (!place.tags.includes("주변 인기 후보") && !place.tags.includes("인기")) return 0;

  if (place.category === "cafe" || place.category === "restaurant") return 16;
  if (place.category === "shopping" || place.category === "popup" || place.category === "exhibition") {
    return 10;
  }

  return 6;
}

function touristSpotScore(place: Place, ctx: ScoreContext): number {
  if (!place.tags.includes("명소")) return 0;

  const slot = getTimeSlot(ctx.hourOfDay);
  const outdoorSpot = place.category === "park" || place.category === "nature";
  const indoorSpot = place.category === "exhibition";

  if (ctx.condition === "실내전용") {
    if (outdoorSpot) return -12;
    if (indoorSpot) return 4;
    return 0;
  }

  if (slot === "night" || slot === "dawn") {
    return outdoorSpot ? -8 : -4;
  }

  if (outdoorSpot) {
    return ctx.condition === "야외최적" ? 10 : 7;
  }

  if (indoorSpot) return 6;
  return 3;
}

export function scorePlace(place: Place, ctx: ScoreContext): number {
  let score = 0;
  const slot = getTimeSlot(ctx.hourOfDay);
  score += Math.max(0, ((30 - place.walkingMinutes) / 30) * 40);
  score += weatherScore(place.category, ctx.condition);
  score += timeScore(place.category, slot);
  score += preferenceScore(place.category, ctx.preferences, slot);
  score += companionPlaceHeuristicScore(place, ctx.preferences.companion, slot);
  score += transportScore(place, ctx.preferences.transport);
  score += ratingScore(place); // 구글 별점/리뷰 수 반영
  score += popularityScore(place); // 카카오 인기/관련도 결과 반영
  score += touristSpotScore(place, ctx); // 관광명소/명소 가점

  if (place.tags.some((tag) => tag.includes("마감") || tag.includes("남음"))) {
    score += 10;
  }

  // 영업 종료 확인 → 사실상 추천 불가 수준
  if (place.isOpen === false) {
    score -= 60;
  }

  const isLateNight = ctx.hourOfDay >= 21 || (ctx.hourOfDay >= 0 && ctx.hourOfDay < 6);
  const isDawn = ctx.hourOfDay >= 0 && ctx.hourOfDay < 6;

  // 야간/새벽: 영업시간 미확인 장소 강한 패널티 (전 카테고리)
  if (isLateNight && place.isOpen === null) {
    score -= 35;
  }
  // 24시간/상시 확인된 장소 새벽 부스트
  if (isDawn && place.isOpen === true) {
    score += 15;
  }

  return Math.round(score);
}

function routeCandidateScore(
  candidate: Place,
  lastPlace: Place | null,
  elapsedMinutes: number,
  baseCondition: WeatherCondition,
  forecast: ForecastEntry[] | undefined
): number {
  const travelMinutes = lastPlace
    ? calcTravelMinutes(lastPlace.coordinates, candidate.coordinates)
    : candidate.walkingMinutes;
  const arrivalOffset = elapsedMinutes + travelMinutes;
  const openAtArrival = candidate.googleHours
    ? isGoogleOpenAtOffset(candidate.googleHours, arrivalOffset)
    : getOpenStateAtOffset(candidate.operatingHours, arrivalOffset);

  let score = candidate.score ?? 0;
  score -= Math.min(travelMinutes, 35) * 0.9;

  if (openAtArrival === true) score += 10;
  if (openAtArrival === false) score -= 80;
  // 영업시간 미확인 → 야간/새벽에는 전 카테고리 패널티
  if (openAtArrival === null) {
    const hour = new Date().getHours();
    if (hour >= 21 || hour < 9) score -= 25;
  }
  if (lastPlace && lastPlace.category === candidate.category) score -= 6;

  // 동적 날씨: 도착 예정 시각의 예보 날씨가 현재와 다르면 delta 반영
  const conditionAtArrival = getConditionAtOffset(baseCondition, arrivalOffset, forecast);
  if (conditionAtArrival !== baseCondition) {
    const delta = weatherScore(candidate.category, conditionAtArrival)
                - weatherScore(candidate.category, baseCondition);
    score += delta;
  }

  return score;
}

function buildCourseFromTemplate(
  sorted: Place[],
  template: Place["category"][],
  excludedIds: Set<string>,
  baseCondition: WeatherCondition,
  forecast: ForecastEntry[] | undefined
): Place[] {
  const result: Place[] = [];
  const usedIds = new Set<string>();
  let elapsedMinutes = 0;
  let lastPlace: Place | null = null;

  for (const category of template) {
    const scoreCandidate = (p: Place) =>
      routeCandidateScore(p, lastPlace, elapsedMinutes, baseCondition, forecast);

    const filterCandidates = (ignoreExcluded: boolean) =>
      sorted
      .filter((place) =>
        place.category === category &&
        !usedIds.has(place.id) &&
        place.isOpen !== false &&
        (ignoreExcluded || !excludedIds.has(place.id))
      )
      .sort((a, b) => scoreCandidate(b) - scoreCandidate(a));

    const candidates = filterCandidates(false);
    const pool = candidates.length > 0 ? candidates : filterCandidates(true);

    const picked = pool.find((candidate) => {
      const travelMinutes = lastPlace
        ? calcTravelMinutes(lastPlace.coordinates, candidate.coordinates)
        : candidate.walkingMinutes;
      const arrivalOffset = elapsedMinutes + travelMinutes;
      const openAtArrival = candidate.googleHours
        ? isGoogleOpenAtOffset(candidate.googleHours, arrivalOffset)
        : getOpenStateAtOffset(candidate.operatingHours, arrivalOffset);
      return openAtArrival !== false;
    }) ?? pool[0];

    if (!picked) continue;

    const travelMinutes = lastPlace
      ? calcTravelMinutes(lastPlace.coordinates, picked.coordinates)
      : picked.walkingMinutes;

    result.push(picked);
    usedIds.add(picked.id);
    elapsedMinutes += travelMinutes + STAY_TIME[picked.category];
    lastPlace = picked;
  }

  return result;
}

function calcDuration(places: Place[]): number {
  if (places.length === 0) return 0;

  let duration = places[0].walkingMinutes + STAY_TIME[places[0].category];
  for (let i = 1; i < places.length; i += 1) {
    duration += calcTravelMinutes(places[i - 1].coordinates, places[i].coordinates);
    duration += STAY_TIME[places[i].category];
  }
  return duration;
}

function limitCourseByDuration(
  places: Place[],
  options: NormalizedOptions
): Place[] {
  if (!options.durationBudgetMinutes) return places;

  const trimmed = [...places];
  while (trimmed.length > 2 && calcDuration(trimmed) > options.durationBudgetMinutes + 20) {
    trimmed.pop();
  }
  return trimmed;
}

function buildFallbackTitle(places: Place[], options: NormalizedOptions): string {
  const titles = places.map((place) => CATEGORY_LABEL[place.category]);
  if (options.selectedCategories.length === 1) {
    return `${CATEGORY_LABEL[options.selectedCategories[0]]} 중심 코스 추천!`;
  }
  if (titles.includes("공원 산책") && titles.includes("카페")) {
    return "힐링 코스 추천!";
  }
  if (titles.includes("전시") || titles.includes("팝업")) {
    return "놀거리 많은 코스 추천!";
  }
  return "지금 어울리는 코스 추천!";
}

function inferIntentFromPlaces(places: Place[]): string {
  const categories = places.map((place) => place.category);
  if (categories.includes("park") || categories.includes("nature")) return "walk";
  if (categories.includes("activity")) return "activity";
  if (categories.includes("shopping")) return "shopping";
  if (categories.includes("exhibition") || categories.includes("popup")) return "culture";
  if (categories.includes("bar")) return "nightlife";
  if (categories.includes("cinema")) return "cinema";
  if (categories.includes("photo")) return "photo";
  if (places.length <= 2) return "short";
  return "general";
}

function makeUniqueTitle(
  title: string,
  places: Place[],
  existingTitles: Set<string>
): string {
  if (!existingTitles.has(title)) return title;

  const qualifiers = [
    places[0] ? `${CATEGORY_LABEL[places[0].category]}부터` : undefined,
    places[1] ? `${CATEGORY_LABEL[places[1].category]} 포함` : undefined,
    "가볍게",
    "지금 딱",
  ].filter((value): value is string => Boolean(value));

  for (const qualifier of qualifiers) {
    const nextTitle = `${title.replace(/ 추천!$/, "")} · ${qualifier}`;
    if (!existingTitles.has(nextTitle)) return nextTitle;
  }

  let index = 2;
  let fallback = `${title.replace(/ 추천!$/, "")} ${index}`;
  while (existingTitles.has(fallback)) {
    index += 1;
    fallback = `${title.replace(/ 추천!$/, "")} ${index}`;
  }
  return fallback;
}

function buildTags(
  condition: WeatherCondition,
  slot: TimeSlot,
  places: Place[],
  options: NormalizedOptions
): string[] {
  const tags: string[] = [];
  const conditionTag: Record<WeatherCondition, string> = {
    야외최적: "맑음 최적",
    쾌적: "쾌적한 날씨",
    실내선호: "실내 위주",
    실내전용: "실내 전용",
  };
  const slotTag: Record<TimeSlot, string> = {
    dawn:      "새벽 추천",
    morning:   "오전 추천",
    lunch:     "점심 추천",
    afternoon: "오후 추천",
    evening:   "저녁 추천",
    night:     "야간 추천",
  };

  tags.push(conditionTag[condition], slotTag[slot]);

  if (options.selectedCategories.length === 1) {
    tags.push(`${CATEGORY_LABEL[options.selectedCategories[0]]} 중심`);
  }

  if (options.companion !== "상관없음") {
    tags.push(options.companion);
  }

  if (places.some((place) => place.tags.includes("오늘 마감"))) {
    tags.push("오늘 마감");
  }

  return tags;
}

function hasSamePlaces(a: Place[], b: Place[]): boolean {
  if (a.length !== b.length) return false;
  const ids = new Set(a.map((place) => place.id));
  return b.every((place) => ids.has(place.id));
}

function pickDiversePlaces(places: Place[], count: number): Place[] {
  const result: Place[] = [];
  const seenCategories = new Set<string>();

  for (const place of places) {
    if (result.length >= count) break;
    if (seenCategories.has(place.category)) continue;
    result.push(place);
    seenCategories.add(place.category);
  }

  return result;
}

function generateWeatherHint(
  places: Place[],
  weather: WeatherInfo,
  hourOfDay: number,
  forecast: ForecastEntry[] | undefined
): string | undefined {
  if (!forecast?.length) return undefined;

  const hasOutdoor = places.some((p) => p.category === "park");
  const allRainy = weather.isRainy && forecast.every((e) => e.isRainy);

  // 종일 비 경고
  if (allRainy) {
    return hasOutdoor
      ? "종일 비 예보가 있어요. 공원 방문은 어려울 수 있어요 ☔"
      : "종일 비 예보가 있어요. 실내 코스를 추천드려요 ☔";
  }

  // 현재 비 → 예보에서 비 그칠 예정
  if (weather.isRainy) {
    const clearEntry = forecast.find((e) => !e.isRainy);
    if (clearEntry) {
      const targetHour = (hourOfDay + clearEntry.offsetHours) % 24;
      const timeLabel = `${targetHour}시`;
      if (hasOutdoor) {
        return `${timeLabel}쯤 비가 그칠 예정이에요. 공원 동선에 참고하세요 ☀️`;
      }
      return `${timeLabel}쯤 비가 그칠 예정이에요 ☀️`;
    }
    return undefined;
  }

  // 현재 맑음 → 예보에서 비 예정
  if (!weather.isRainy && hasOutdoor) {
    const rainEntry = forecast.find((e) => e.isRainy);
    if (rainEntry && rainEntry.offsetHours <= 3) {
      const targetHour = (hourOfDay + rainEntry.offsetHours) % 24;
      return `${targetHour}시쯤 비가 올 수 있어요. 공원은 서둘러 방문하세요 ☔`;
    }
  }

  return undefined;
}

export function buildCourses(
  scoredPlaces: Place[],
  weather: WeatherInfo,
  hour: number = new Date().getHours(),
  options?: RecommendationOptions,
  forecast?: ForecastEntry[]
): Course[] {
  const normalized = normalizeOptions(options);
  const condition = getWeatherCondition(weather, normalized.weatherAware);
  const slot = getTimeSlot(hour);
  const sorted = [...scoredPlaces].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  const templates = dedupeTemplates([
    ...buildFeaturedTemplates(slot, condition),
    ...buildCompanionTemplates(slot, normalized, condition),
    ...BASE_TEMPLATES[slot],
    ...buildConditionTemplates(slot, condition),
    ...buildFocusTemplates(slot, normalized),
  ]);
  const courses: Course[] = [];
  const usedPlaceIdsAcrossCourses = new Set<string>();
  const existingTitles = new Set<string>();
  const usedIntents = new Set<string>();

  for (const rawTemplate of templates) {
    const template = applyPreferencesToTemplate(rawTemplate, condition, normalized);
    if (!template.featured && usedIntents.has(template.intent)) continue;
    const places = limitCourseByDuration(
      buildCourseFromTemplate(sorted, template.categories, usedPlaceIdsAcrossCourses, condition, forecast),
      normalized
    );
    if (places.length < 2) continue;
    if (courses.some((course) => hasSamePlaces(course.places, places))) continue;

    const resolvedIntent = template.featured ? "featured" : template.intent || inferIntentFromPlaces(places);
    if (!template.featured && usedIntents.has(resolvedIntent)) continue;

    const title = makeUniqueTitle(template.title, places, existingTitles);

    const weatherHint = generateWeatherHint(places, weather, hour, forecast);

    courses.push({
      id: `course-${courses.length + 1}`,
      title,
      durationMinutes: calcDuration(places),
      places,
      tags: buildTags(condition, slot, places, normalized),
      weatherHint,
    });

    existingTitles.add(title);
    usedIntents.add(resolvedIntent);
    for (const place of places) usedPlaceIdsAcrossCourses.add(place.id);

    if (courses.length >= 5) break;
  }

  const fallbackCount = getDesiredStopCount(normalized);
  const minCourses = slot === "dawn" ? 0 : 3; // 새벽은 강제 최소 코스 없음
  while (courses.length < minCourses) {
    const usedIds = new Set(courses.flatMap((course) => course.places.map((place) => place.id)));
    const fallbackPlaces = pickDiversePlaces(
      sorted.filter((place) => !usedIds.has(place.id) && place.isOpen !== false),
      fallbackCount
    );
    if (fallbackPlaces.length < 2) break;

    const fallbackIntent = inferIntentFromPlaces(fallbackPlaces);
    if (usedIntents.has(fallbackIntent) && courses.length > 0) break;

    const title = makeUniqueTitle(
      buildFallbackTitle(fallbackPlaces, normalized),
      fallbackPlaces,
      existingTitles
    );

    courses.push({
      id: `course-${courses.length + 1}`,
      title,
      durationMinutes: calcDuration(fallbackPlaces),
      places: fallbackPlaces,
      tags: buildTags(condition, slot, fallbackPlaces, normalized),
      weatherHint: generateWeatherHint(fallbackPlaces, weather, hour, forecast),
    });
    existingTitles.add(title);
    usedIntents.add(fallbackIntent);
  }

  return courses;
}
