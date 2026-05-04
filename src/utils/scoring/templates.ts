import type { Place } from "../../types";
import type {
  CourseTemplate, NormalizedOptions, WeatherCondition, TimeSlot,
} from "./types";
import { CATEGORY_LABEL, isIndoorCategory } from "./types";

export const CATEGORY_ORDER_BY_SLOT: Record<TimeSlot, Place["category"][]> = {
  dawn:      ["park", "cafe", "exhibition", "shopping", "mall", "popup", "restaurant", "nature", "photo", "bar", "cinema", "activity"],
  morning:   ["popup", "exhibition", "cafe", "park", "shopping", "mall", "restaurant", "photo", "nature", "cinema", "bar", "activity"],
  lunch:     ["restaurant", "popup", "exhibition", "cafe", "shopping", "mall", "park", "photo", "cinema", "nature", "bar", "activity"],
  afternoon: ["popup", "exhibition", "shopping", "mall", "cafe", "park", "restaurant", "photo", "cinema", "activity", "nature", "bar"],
  evening:   ["restaurant", "activity", "popup", "exhibition", "bar", "mall", "shopping", "cafe", "park", "photo", "cinema", "nature"],
  night:     ["activity", "bar", "restaurant", "cafe", "cinema", "mall", "shopping", "popup", "exhibition", "photo", "nature", "park"],
};

export const BASE_TEMPLATES: Record<TimeSlot, CourseTemplate[]> = {
  dawn: [
    { categories: ["park", "cafe"], title: "새벽 산책 코스 추천!", intent: "walk" },
    { categories: ["park"], title: "새벽 공원 산책 추천!", intent: "park-only" },
  ],
  morning: [
    { categories: ["cafe", "park", "exhibition"], title: "아침 산책 코스 추천!", intent: "walk" },
    { categories: ["cafe", "exhibition", "popup"], title: "느긋한 문화 코스 추천!", intent: "culture" },
    { categories: ["cafe", "nature", "restaurant"], title: "명소 둘러보는 오전 코스 추천!", intent: "landmark" },
    { categories: ["shopping", "cafe", "park"], title: "가볍게 둘러보는 오전 코스 추천!", intent: "browse" },
    { categories: ["mall", "cafe", "restaurant"], title: "실내에서 편하게 보내는 오전 코스 추천!", intent: "mall" },
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
    { categories: ["mall", "restaurant", "cafe"], title: "쇼핑몰에서 편하게 보내는 코스 추천!", intent: "mall" },
    { categories: ["restaurant", "photo", "cafe"], title: "맛집 후 감성 코스 추천!", intent: "photo" },
    { categories: ["activity", "restaurant", "popup"], title: "실내 놀거리 코스 추천!", intent: "activity" },
    { categories: ["restaurant", "cafe"], title: "짧고 깔끔한 점심 코스 추천!", intent: "short" },
  ],
  afternoon: [
    { categories: ["shopping", "cafe", "park"], title: "소품샵 구경 코스 추천!", intent: "shopping" },
    { categories: ["mall", "restaurant", "cafe"], title: "쇼핑몰 중심 오후 코스 추천!", intent: "mall" },
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
    { categories: ["mall", "restaurant", "cafe"], title: "실내에서 편하게 보내는 저녁 코스 추천!", intent: "mall" },
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
    { categories: ["mall", "restaurant"], title: "쇼핑몰 중심 야간 코스 추천!", intent: "mall" },
    { categories: ["restaurant", "exhibition"], title: "야간 실내 코스 추천!", intent: "culture" },
  ],
};

export const PARK_FALLBACKS: Place["category"][] = [
  "mall", "exhibition", "popup", "shopping", "cafe", "cinema", "photo",
];

export function normalizeOptions(options?: import("./types").RecommendationOptions): NormalizedOptions {
  const durationBudgetMinutes = (() => {
    switch (options?.duration) {
      case "1h": return 90;
      case "2h": return 150;
      case "3h": return 210;
      case "4h+":
      case "5h": return 300;
      default: return null;
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

export function getDesiredStopCount(options: NormalizedOptions): number {
  if (!options.durationBudgetMinutes) return 3;
  if (options.durationBudgetMinutes <= 90) return 2;
  return 3;
}

export function dedupeTemplates(templates: CourseTemplate[]): CourseTemplate[] {
  const seen = new Set<string>();
  return templates.filter((t) => {
    const key = t.categories.join(",");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function swapParkForIndoor(template: Place["category"][]): Place["category"][] {
  const used = new Set<Place["category"]>();
  return template.map((category) => {
    if (category !== "park") { used.add(category); return category; }
    const fallback = PARK_FALLBACKS.find((item) => !used.has(item));
    const replacement = fallback ?? "cafe";
    used.add(replacement);
    return replacement;
  });
}

export function applyPreferencesToTemplate(
  template: CourseTemplate,
  condition: WeatherCondition,
  options: NormalizedOptions,
): CourseTemplate {
  let adjusted = [...template.categories];

  if (condition === "실내전용" || condition === "실내선호" || options.environment === "실내") {
    adjusted = swapParkForIndoor(adjusted);
  }

  if (options.environment === "야외" && condition !== "실내전용") {
    if (!adjusted.includes("park")) adjusted[adjusted.length - 1] = "park";
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

  return { ...template, title, categories: deduped.slice(0, getDesiredStopCount(options)) };
}

export function buildFocusTemplates(slot: TimeSlot, options: NormalizedOptions): CourseTemplate[] {
  return options.selectedCategories.map((category) => {
    const ordered = [category, ...CATEGORY_ORDER_BY_SLOT[slot].filter((item) => item !== category)];
    return {
      categories: ordered.slice(0, getDesiredStopCount(options)),
      title: `${CATEGORY_LABEL[category]} 중심 코스 추천!`,
      intent: `focus-${category}`,
    };
  });
}

export function buildCompanionTemplates(
  slot: TimeSlot,
  options: NormalizedOptions,
  condition: WeatherCondition,
): CourseTemplate[] {
  const indoorSafe = condition === "실내전용" || condition === "실내선호";

  switch (options.companion) {
    case "아이와 함께":
      switch (slot) {
        case "morning": return indoorSafe
          ? [{ categories: ["mall", "activity", "restaurant"], title: "아이와 함께 쇼핑몰 실내 코스 추천!", intent: "kids-mall" }]
          : [{ categories: ["park", "activity", "cafe"], title: "아이와 함께 가볍게 노는 코스 추천!", intent: "kids-play" }];
        case "lunch": return indoorSafe
          ? [{ categories: ["mall", "activity", "restaurant"], title: "아이와 함께 쇼핑몰 점심 코스 추천!", intent: "kids-mall" }]
          : [{ categories: ["restaurant", "park", "cafe"], title: "아이와 함께 점심 산책 코스 추천!", intent: "kids-lunch" }];
        case "afternoon": return indoorSafe
          ? [
              { categories: ["mall", "activity", "restaurant"], title: "아이와 함께 쇼핑몰 키즈존 코스 추천!", intent: "kids-mall" },
              { categories: ["activity", "restaurant", "cafe"], title: "아이와 함께 실내 놀거리 코스 추천!", intent: "kids-play" },
              { categories: ["cinema", "restaurant", "cafe"], title: "아이와 함께 영화 코스 추천!", intent: "kids-cinema" },
            ]
          : [
              { categories: ["park", "restaurant", "cafe"], title: "아이와 함께 공원 나들이 코스 추천!", intent: "kids-picnic" },
              { categories: ["nature", "restaurant", "cafe"], title: "아이와 함께 바깥 나들이 코스 추천!", intent: "kids-outdoor" },
              { categories: ["activity", "restaurant", "cafe"], title: "아이와 함께 체험 코스 추천!", intent: "kids-play" },
            ];
        case "evening": return indoorSafe
          ? [{ categories: ["mall", "restaurant", "cafe"], title: "아이와 함께 저녁 쇼핑몰 코스 추천!", intent: "kids-evening" }]
          : [{ categories: ["restaurant", "park", "cafe"], title: "아이와 함께 저녁 나들이 코스 추천!", intent: "kids-evening" }];
        case "night": return [{ categories: ["restaurant", "cinema"], title: "아이와 함께 편한 야간 코스 추천!", intent: "kids-night" }];
        default: return [];
      }

    case "데이트":
      switch (slot) {
        case "morning": return [{ categories: ["cafe", "park", "exhibition"], title: "데이트 산책 코스 추천!", intent: "date-walk" }];
        case "lunch": return [{ categories: ["restaurant", "cafe", "popup"], title: "데이트 점심 코스 추천!", intent: "date-lunch" }];
        case "afternoon": return [
          { categories: ["cafe", "exhibition", "photo"], title: "감성 데이트 코스 추천!", intent: "date-mood" },
          { categories: ["cinema", "cafe", "restaurant"], title: "영화 데이트 코스 추천!", intent: "date-cinema" },
          { categories: ["popup", "cafe", "park"], title: "구경거리 많은 데이트 코스 추천!", intent: "date-browse" },
        ];
        case "evening": return indoorSafe
          ? [
              { categories: ["restaurant", "cinema", "cafe"], title: "저녁 영화 데이트 코스 추천!", intent: "date-cinema" },
              { categories: ["restaurant", "exhibition", "cafe"], title: "저녁 데이트 코스 추천!", intent: "date-evening" },
            ]
          : [
              { categories: ["restaurant", "park", "cafe"], title: "저녁 산책 데이트 코스 추천!", intent: "date-evening" },
              { categories: ["restaurant", "cinema", "cafe"], title: "저녁 영화 데이트 코스 추천!", intent: "date-cinema" },
              { categories: ["restaurant", "bar", "cafe"], title: "분위기 좋은 데이트 코스 추천!", intent: "date-night" },
            ];
        case "night": return [
          { categories: ["bar", "cafe"], title: "야간 데이트 코스 추천!", intent: "date-night" },
          { categories: ["cinema", "restaurant"], title: "심야 데이트 코스 추천!", intent: "date-cinema" },
        ];
        default: return [];
      }

    case "친구들과":
      switch (slot) {
        case "lunch": return [{ categories: ["restaurant", "activity", "cafe"], title: "친구들과 놀기 좋은 점심 코스 추천!", intent: "friends-lunch" }];
        case "afternoon": return [
          { categories: ["activity", "cafe", "popup"], title: "친구들과 놀거리 코스 추천!", intent: "friends-play" },
          { categories: ["cinema", "restaurant", "cafe"], title: "친구들과 영화 코스 추천!", intent: "friends-cinema" },
        ];
        case "evening": return [
          { categories: ["restaurant", "activity", "bar"], title: "친구들과 저녁 놀거리 코스 추천!", intent: "friends-evening" },
          { categories: ["restaurant", "bar", "cafe"], title: "친구들과 모임 코스 추천!", intent: "friends-drink" },
        ];
        case "night": return [{ categories: ["activity", "bar"], title: "친구들과 야간 코스 추천!", intent: "friends-night" }];
        default: return [];
      }

    case "직장모임":
      switch (slot) {
        case "lunch": return [{ categories: ["restaurant", "cafe"], title: "직장모임 점심 코스 추천!", intent: "coworkers-lunch" }];
        case "afternoon": return [
          { categories: ["activity", "restaurant", "bar"], title: "팀워크형 직장모임 코스 추천!", intent: "coworkers-team" },
          { categories: ["restaurant", "cafe"], title: "가볍게 만나는 직장모임 코스 추천!", intent: "coworkers-light" },
        ];
        case "evening": return [
          { categories: ["restaurant", "cafe", "bar"], title: "직장모임 저녁 코스 추천!", intent: "coworkers-evening" },
          { categories: ["activity", "restaurant", "bar"], title: "액티비티 직장모임 코스 추천!", intent: "coworkers-team" },
          { categories: ["restaurant", "cafe"], title: "편하게 끝나는 직장모임 코스 추천!", intent: "coworkers-short" },
        ];
        case "night": return [{ categories: ["restaurant", "bar"], title: "직장모임 야간 코스 추천!", intent: "coworkers-night" }];
        default: return [];
      }

    case "가족과":
      switch (slot) {
        case "morning": return indoorSafe
          ? [{ categories: ["mall", "restaurant", "cafe"], title: "가족과 실내 쇼핑몰 코스 추천!", intent: "family-indoor" }]
          : [{ categories: ["park", "restaurant", "cafe"], title: "가족과 오전 나들이 코스 추천!", intent: "family-outing" }];
        case "lunch": return [
          { categories: ["restaurant", "park", "cafe"], title: "가족과 점심 나들이 코스 추천!", intent: "family-lunch" },
          { categories: ["mall", "restaurant", "cafe"], title: "가족과 편하게 보내는 쇼핑몰 코스 추천!", intent: "family-mall" },
          { categories: ["restaurant", "exhibition", "cafe"], title: "가족과 문화 코스 추천!", intent: "family-culture" },
          { categories: ["restaurant", "cafe"], title: "가족과 카페 중심 코스 추천!", intent: "family-cafe" },
        ];
        case "afternoon": return indoorSafe
          ? [
              { categories: ["mall", "restaurant", "cafe"], title: "가족과 실내 쇼핑몰 코스 추천!", intent: "family-mall" },
              { categories: ["exhibition", "restaurant", "cafe"], title: "가족과 실내 구경 코스 추천!", intent: "family-browse" },
              { categories: ["restaurant", "cafe"], title: "가족과 카페 중심 코스 추천!", intent: "family-cafe" },
            ]
          : [
              { categories: ["park", "restaurant", "cafe"], title: "가족과 오후 나들이 코스 추천!", intent: "family-outing" },
              { categories: ["nature", "restaurant", "cafe"], title: "가족과 드라이브 느낌 코스 추천!", intent: "family-drive" },
            ];
        case "evening": return [
          { categories: ["restaurant", "park", "cafe"], title: "가족과 저녁 산책 코스 추천!", intent: "family-evening" },
          { categories: ["restaurant", "cinema", "cafe"], title: "가족과 저녁 실내 코스 추천!", intent: "family-cinema" },
          { categories: ["restaurant", "exhibition"], title: "가족과 문화생활 코스 추천!", intent: "family-culture" },
        ];
        case "night": return [{ categories: ["restaurant", "cafe"], title: "가족과 편한 야간 코스 추천!", intent: "family-night" }];
        default: return [];
      }

    default: return [];
  }
}

export function buildFeaturedTemplates(slot: TimeSlot, condition: WeatherCondition): CourseTemplate[] {
  const title = condition === "실내전용" || condition === "실내선호"
    ? "지금 어울리는 실내 코스 추천!"
    : "지금 어울리는 코스 추천!";

  switch (slot) {
    case "dawn": return [{ categories: ["park", "cafe"], title, intent: "featured", featured: true }];
    case "morning":
      if (condition === "야외최적") return [{ categories: ["cafe", "park", "exhibition"], title, intent: "featured", featured: true }];
      return [{ categories: ["cafe", "exhibition", "mall"], title, intent: "featured", featured: true }];
    case "lunch":
      if (condition === "야외최적") return [{ categories: ["restaurant", "park", "cafe"], title, intent: "featured", featured: true }];
      if (condition === "실내전용" || condition === "실내선호") return [{ categories: ["restaurant", "exhibition", "cafe"], title, intent: "featured", featured: true }];
      return [{ categories: ["restaurant", "cafe", "popup"], title, intent: "featured", featured: true }];
    case "afternoon":
      if (condition === "야외최적") return [{ categories: ["shopping", "cafe", "park"], title, intent: "featured", featured: true }];
      if (condition === "실내전용" || condition === "실내선호") return [{ categories: ["exhibition", "cafe", "mall"], title, intent: "featured", featured: true }];
      return [{ categories: ["popup", "cafe", "exhibition"], title, intent: "featured", featured: true }];
    case "evening":
      if (condition === "야외최적") return [{ categories: ["restaurant", "park", "cafe"], title, intent: "featured", featured: true }];
      if (condition === "실내전용" || condition === "실내선호") return [{ categories: ["restaurant", "mall", "cafe"], title, intent: "featured", featured: true }];
      return [{ categories: ["restaurant", "activity", "popup"], title, intent: "featured", featured: true }];
    case "night":
      if (condition === "실내전용" || condition === "실내선호") return [{ categories: ["activity", "bar"], title, intent: "featured", featured: true }];
      return [{ categories: ["restaurant", "bar"], title, intent: "featured", featured: true }];
  }
}

export function buildConditionTemplates(slot: TimeSlot, condition: WeatherCondition): CourseTemplate[] {
  if (condition === "야외최적") {
    if (slot === "evening") return [
      { categories: ["cafe", "restaurant", "park"], title: "테라스 감성 코스 추천!", intent: "terrace" },
      { categories: ["shopping", "restaurant", "cafe"], title: "소품샵 구경 코스 추천!", intent: "shopping" },
      { categories: ["restaurant", "park", "cafe"], title: "퇴근 후 힐링 코스 추천!", intent: "healing" },
    ];
    if (slot === "afternoon") return [
      { categories: ["shopping", "cafe", "park"], title: "햇살 좋은 산책 코스 추천!", intent: "walk" },
      { categories: ["popup", "cafe", "park"], title: "놀거리 많은 코스 추천!", intent: "browse" },
    ];
  }

  if (condition === "실내전용") {
    if (slot === "evening" || slot === "night") return [
      { categories: ["restaurant", "activity"], title: "비 오는 날 실내 놀이 코스 추천!", intent: "activity" },
      { categories: ["mall", "restaurant", "cafe"], title: "비 오는 날 쇼핑몰 코스 추천!", intent: "mall" },
      { categories: ["restaurant", "exhibition", "cafe"], title: "저녁 문화 코스 추천!", intent: "culture" },
    ];
    return [
      { categories: ["activity", "cafe"], title: "비 오는 날 실내 액티비티 코스 추천!", intent: "activity" },
      { categories: ["mall", "restaurant", "cafe"], title: "비 오는 날 쇼핑몰 코스 추천!", intent: "mall" },
      { categories: ["exhibition", "cafe", "shopping"], title: "비 오는 날 실내 코스 추천!", intent: "culture" },
    ];
  }

  if (condition === "실내선호") {
    if (slot === "evening") return [
      { categories: ["mall", "restaurant", "cafe"], title: "실내 위주 저녁 코스 추천!", intent: "mall" },
      { categories: ["restaurant", "exhibition", "cafe"], title: "저녁 문화 코스 추천!", intent: "culture" },
    ];
    return [
      { categories: ["exhibition", "cafe", "mall"], title: "실내에서 쉬기 좋은 코스 추천!", intent: "quiet" },
      { categories: ["mall", "cafe", "popup"], title: "실내 구경 코스 추천!", intent: "mall" },
    ];
  }

  return [];
}
