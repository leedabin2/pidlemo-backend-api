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
    // 5~7시 이른 아침 패턴 (featured와 같은 categories라 deduped되지만 fallback으로 존재)
    { categories: ["park", "cafe"], title: "새벽 산책 코스 추천!", intent: "walk" },
    // 0~2시 2차 타임 패턴 (bar isOpen=true일 때만 실제로 코스 생성됨)
    { categories: ["bar", "cafe"], title: "새벽 2차 코스 추천!", intent: "nightlife" },
    // 5~8시 해장 패턴
    { categories: ["restaurant", "park", "cafe"], title: "새벽 해장 코스 추천!", intent: "healing" },
    { categories: ["park"], title: "새벽 공원 산책 추천!", intent: "park-only" },
  ],
  morning: [
    { categories: ["cafe", "park", "exhibition"], title: "아침 산책 코스 추천!", intent: "walk" },
    { categories: ["cafe", "exhibition", "popup"], title: "느긋한 문화 코스 추천!", intent: "culture" },
    // 8~11시 브런치 타임 패턴
    { categories: ["restaurant", "cafe", "park"], title: "브런치 산책 코스 추천!", intent: "brunch" },
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
    // 14~17 "가장 놀기 좋은 시간" → activity/전시 코스를 앞으로
    { categories: ["activity", "exhibition", "popup"], title: "놀거리 많은 코스 추천!", intent: "activity" },
    { categories: ["cafe", "popup", "park"], title: "가볍게 돌아다니는 코스 추천!", intent: "browse" },
    { categories: ["mall", "restaurant", "cafe"], title: "쇼핑몰 중심 오후 코스 추천!", intent: "mall" },
    { categories: ["cafe", "exhibition", "nature"], title: "구경거리 많은 오후 코스 추천!", intent: "landmark" },
    { categories: ["park", "cafe", "restaurant"], title: "햇살 좋은 힐링 코스 추천!", intent: "healing" },
    { categories: ["cafe", "photo", "shopping"], title: "감성 오후 코스 추천!", intent: "photo" },
    { categories: ["cinema", "cafe"], title: "영화 데이트 코스 추천!", intent: "cinema" },
    { categories: ["popup", "cafe", "exhibition"], title: "트렌디한 오후 코스 추천!", intent: "trend" },
    { categories: ["cafe", "exhibition"], title: "차분한 실내 코스 추천!", intent: "quiet" },
  ],
  evening: [
    { categories: ["restaurant", "bar", "cafe"], title: "저녁 감성 코스 추천!", intent: "nightlife" },
    { categories: ["restaurant", "cafe", "park"], title: "테라스 감성 코스 추천!", intent: "terrace" },
    // 17~19 저녁 전환 패턴: 노을 구경 → 카페 → 가벼운 술
    { categories: ["park", "cafe", "bar"], title: "노을 저녁 코스 추천!", intent: "sunset" },
    // 19~22 저녁 메인 + 저녁 8시 이미 식사한 경우 대응
    { categories: ["activity", "bar", "cafe"], title: "저녁 놀거리 코스 추천!", intent: "activity-evening" },
    { categories: ["restaurant", "activity"], title: "식사 후 놀거리 코스 추천!", intent: "activity" },
    { categories: ["bar", "restaurant", "cafe"], title: "저녁 술 한잔 코스 추천!", intent: "bar-first" },
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
    // 22~24 야간 메인: 바 → 카페, 액티비티 → 바
    { categories: ["bar", "cafe"], title: "야간 감성 코스 추천!", intent: "nightlife" },
    { categories: ["activity", "bar"], title: "야간 실내 놀이 코스 추천!", intent: "activity" },
    { categories: ["restaurant", "bar"], title: "밤에 술 한잔 코스 추천!", intent: "bar-dinner" },
    { categories: ["cinema", "cafe"], title: "심야 영화 후 카페 코스 추천!", intent: "cinema" },
    { categories: ["activity", "cafe"], title: "야간 놀고 카페 코스 추천!", intent: "activity-cafe" },
    { categories: ["restaurant", "activity"], title: "밤까지 즐기는 코스 추천!", intent: "play" },
    { categories: ["restaurant", "cafe"], title: "늦은 시간 편한 코스 추천!", intent: "short" },
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
    requireParking: options?.requireParking ?? false,
    requireRestroom: options?.requireRestroom ?? false,
    requireChildFacilities: options?.requireChildFacilities ?? false,
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

  if (options.companion === "아이와 함께") {
    adjusted = adjusted.filter((category) => category !== "bar" && category !== "shopping");
    if ((condition === "실내전용" || condition === "실내선호") && adjusted[0] === "restaurant" && !adjusted.includes("mall")) {
      adjusted = ["mall", ...adjusted];
    }
  }
  if (options.companion === "가족과") {
    adjusted = adjusted.filter((category) => category !== "bar" && category !== "shopping");
  }
  if (options.companion === "직장모임") {
    adjusted = adjusted.filter((category) => category !== "shopping");
  }

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
  if (title.includes("소품샵") && !deduped.includes("shopping")) {
    title = deduped.includes("mall") ? "쇼핑몰 중심 코스 추천!" : "식사 후 편한 코스 추천!";
  }
  if (title.includes("체험") && !deduped.includes("activity")) {
    title = "아이와 함께 편한 코스 추천!";
  }
  if ((title.includes("술") || title.includes("2차")) && !deduped.includes("bar")) {
    title = "저녁에 편하게 즐기는 코스 추천!";
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
    // ── 아이와 함께 ──────────────────────────────────────────────
    // 실내: 쇼핑몰(키즈존) 우선, activity 슬롯 제거(방탈출/오락실 부적합)
    // 야외: 공원/자연 피크닉 → 식사 → 카페
    case "아이와 함께":
      switch (slot) {
        case "morning": return indoorSafe
          ? [{ categories: ["mall", "restaurant", "cafe"], title: "아이와 함께 쇼핑몰 나들이 코스 추천!", intent: "kids-mall", blocksIntents: ["mall", "walk"] }]
          : [{ categories: ["park", "restaurant", "cafe"], title: "아이와 함께 공원 피크닉 코스 추천!", intent: "kids-picnic", blocksIntents: ["walk", "healing"] }];
        case "lunch": return indoorSafe
          ? [{ categories: ["mall", "restaurant", "cafe"], title: "아이와 함께 쇼핑몰 점심 코스 추천!", intent: "kids-mall", blocksIntents: ["mall"] }]
          : [{ categories: ["restaurant", "park", "cafe"], title: "아이와 함께 점심 산책 코스 추천!", intent: "kids-lunch", blocksIntents: ["walk"] }];
        case "afternoon": return indoorSafe
          ? [
              { categories: ["mall", "restaurant", "cafe"], title: "아이와 함께 쇼핑몰 코스 추천!", intent: "kids-mall", blocksIntents: ["mall"] },
              { categories: ["cinema", "restaurant", "cafe"], title: "아이와 함께 영화 코스 추천!", intent: "kids-cinema", blocksIntents: ["cinema"] },
            ]
          : [
              { categories: ["park", "restaurant", "cafe"], title: "아이와 함께 공원 나들이 코스 추천!", intent: "kids-picnic", blocksIntents: ["walk", "healing"] },
              { categories: ["nature", "restaurant", "cafe"], title: "아이와 함께 자연 나들이 코스 추천!", intent: "kids-outdoor", blocksIntents: ["landmark"] },
              { categories: ["cinema", "restaurant", "cafe"], title: "아이와 함께 영화 코스 추천!", intent: "kids-cinema", blocksIntents: ["cinema"] },
            ];
        case "evening": return indoorSafe
          ? [{ categories: ["mall", "restaurant", "cafe"], title: "아이와 함께 저녁 쇼핑몰 코스 추천!", intent: "kids-evening", blocksIntents: ["mall"] }]
          : [{ categories: ["restaurant", "park", "cafe"], title: "아이와 함께 저녁 나들이 코스 추천!", intent: "kids-evening", blocksIntents: ["healing", "terrace"] }];
        case "night": return [{ categories: ["restaurant", "cinema"], title: "아이와 함께 편한 야간 코스 추천!", intent: "kids-night", blocksIntents: ["cinema"] }];
        default: return [];
      }

    // ── 데이트 ───────────────────────────────────────────────────
    // 분위기 + 대화 흐름 중심
    // 저녁: 야경 산책 → 술 루트 추가 / 브런치 → 전시 → 감성 루트
    case "데이트":
      switch (slot) {
        case "morning": return [
          { categories: ["cafe", "exhibition", "park"], title: "브런치 데이트 코스 추천!", intent: "date-walk", blocksIntents: ["walk", "quiet"] },
        ];
        case "lunch": return [
          { categories: ["restaurant", "cafe", "popup"], title: "데이트 점심 코스 추천!", intent: "date-lunch", blocksIntents: ["browse"] },
        ];
        case "afternoon": return [
          { categories: ["cafe", "exhibition", "photo"], title: "감성 데이트 코스 추천!", intent: "date-mood", blocksIntents: ["culture", "photo"] },
          { categories: ["cinema", "cafe", "restaurant"], title: "영화 데이트 코스 추천!", intent: "date-cinema", blocksIntents: ["cinema"] },
          { categories: ["popup", "cafe", "park"], title: "트렌디한 데이트 코스 추천!", intent: "date-browse", blocksIntents: ["trend", "browse"] },
        ];
        case "evening": return indoorSafe
          ? [
              { categories: ["restaurant", "cinema", "cafe"], title: "저녁 영화 데이트 코스 추천!", intent: "date-cinema", blocksIntents: ["cinema"] },
              { categories: ["restaurant", "bar", "cafe"], title: "분위기 좋은 데이트 코스 추천!", intent: "date-night", blocksIntents: ["nightlife"] },
            ]
          : [
              { categories: ["restaurant", "park", "bar"], title: "야경 데이트 코스 추천!", intent: "date-evening", blocksIntents: ["healing", "terrace"] },
              { categories: ["restaurant", "cinema", "cafe"], title: "저녁 영화 데이트 코스 추천!", intent: "date-cinema", blocksIntents: ["cinema"] },
              { categories: ["restaurant", "bar", "cafe"], title: "분위기 좋은 데이트 코스 추천!", intent: "date-night", blocksIntents: ["nightlife"] },
            ];
        case "night": return [
          { categories: ["bar", "cafe"], title: "야간 데이트 코스 추천!", intent: "date-night", blocksIntents: ["nightlife", "healing"] },
          { categories: ["cinema", "restaurant"], title: "심야 데이트 코스 추천!", intent: "date-cinema", blocksIntents: ["cinema"] },
        ];
        default: return [];
      }

    // ── 친구들과 ─────────────────────────────────────────────────
    // 자유도 높게, 오전 슬롯 추가, 다양한 루트
    case "친구들과":
      switch (slot) {
        case "morning": return [
          { categories: ["cafe", "popup", "park"], title: "친구들과 가볍게 시작하는 코스 추천!", intent: "friends-morning", blocksIntents: ["browse", "walk"] },
        ];
        case "lunch": return [
          { categories: ["restaurant", "activity", "cafe"], title: "친구들과 놀기 좋은 점심 코스 추천!", intent: "friends-lunch", blocksIntents: ["activity"] },
          { categories: ["restaurant", "cafe", "popup"], title: "친구들과 점심 구경 코스 추천!", intent: "friends-browse", blocksIntents: ["browse"] },
        ];
        case "afternoon": return [
          { categories: ["activity", "cafe", "popup"], title: "친구들과 놀거리 코스 추천!", intent: "friends-play", blocksIntents: ["activity", "trend"] },
          { categories: ["cinema", "restaurant", "cafe"], title: "친구들과 영화 코스 추천!", intent: "friends-cinema", blocksIntents: ["cinema"] },
          { categories: ["shopping", "cafe", "restaurant"], title: "친구들과 구경하며 먹는 코스 추천!", intent: "friends-shop", blocksIntents: ["shopping"] },
        ];
        case "evening": return [
          { categories: ["restaurant", "activity", "bar"], title: "친구들과 신나는 저녁 코스 추천!", intent: "friends-evening", blocksIntents: ["activity", "nightlife"] },
          { categories: ["restaurant", "cafe", "popup"], title: "친구들과 여유로운 저녁 코스 추천!", intent: "friends-chill", blocksIntents: ["trend"] },
          { categories: ["restaurant", "bar", "cafe"], title: "친구들과 술 한잔 코스 추천!", intent: "friends-drink", blocksIntents: ["nightlife"] },
        ];
        case "night": return [
          { categories: ["activity", "bar"], title: "친구들과 야간 코스 추천!", intent: "friends-night", blocksIntents: ["activity", "nightlife"] },
          { categories: ["restaurant", "bar"], title: "친구들과 2차 코스 추천!", intent: "friends-night2", blocksIntents: ["nightlife"] },
        ];
        default: return [];
      }

    // ── 직장모임 ─────────────────────────────────────────────────
    // 중간 이탈 가능 구조: 식사→카페→(선택)술 / 액티비티→식사→술
    case "직장모임":
      switch (slot) {
        case "lunch": return [
          { categories: ["restaurant", "cafe"], title: "직장모임 점심 코스 추천!", intent: "coworkers-lunch", blocksIntents: ["short"] },
        ];
        case "afternoon": return [
          { categories: ["activity", "restaurant", "bar"], title: "팀빌딩 직장모임 코스 추천!", intent: "coworkers-team", blocksIntents: ["activity"] },
          { categories: ["restaurant", "cafe"], title: "가볍게 만나는 직장모임 코스 추천!", intent: "coworkers-light", blocksIntents: ["short"] },
        ];
        case "evening": return [
          { categories: ["restaurant", "cafe", "bar"], title: "직장모임 저녁 코스 추천!", intent: "coworkers-evening", blocksIntents: ["nightlife", "healing"] },
          { categories: ["activity", "restaurant", "bar"], title: "액티비티 직장모임 코스 추천!", intent: "coworkers-team", blocksIntents: ["activity"] },
          { categories: ["restaurant", "cafe"], title: "편하게 끝나는 직장모임 코스 추천!", intent: "coworkers-short", blocksIntents: ["short"] },
        ];
        case "night": return [
          { categories: ["restaurant", "bar"], title: "직장모임 2차 코스 추천!", intent: "coworkers-night", blocksIntents: ["nightlife"] },
        ];
        default: return [];
      }

    // ── 가족과 ───────────────────────────────────────────────────
    // 아이와 함께와 구분: 이동 최소 + 조용한 분위기 + 어른도 즐거운
    // 부모님 포함: 맛집(좌석 편한 곳) → 카페 → 가벼운 산책
    case "가족과":
      switch (slot) {
        case "morning": return indoorSafe
          ? [{ categories: ["mall", "cafe", "restaurant"], title: "가족과 실내 나들이 코스 추천!", intent: "family-indoor", blocksIntents: ["mall"] }]
          : [{ categories: ["park", "cafe", "restaurant"], title: "가족과 오전 산책 코스 추천!", intent: "family-outing", blocksIntents: ["walk", "healing"] }];
        case "lunch": return [
          { categories: ["restaurant", "cafe", "park"], title: "가족과 점심 나들이 코스 추천!", intent: "family-lunch", blocksIntents: ["walk"] },
          { categories: ["mall", "restaurant", "cafe"], title: "가족과 편하게 보내는 쇼핑몰 코스 추천!", intent: "family-mall", blocksIntents: ["mall"] },
          { categories: ["restaurant", "exhibition", "cafe"], title: "가족과 문화 코스 추천!", intent: "family-culture", blocksIntents: ["culture"] },
        ];
        case "afternoon": return indoorSafe
          ? [
              { categories: ["mall", "restaurant", "cafe"], title: "가족과 실내 쇼핑몰 코스 추천!", intent: "family-mall", blocksIntents: ["mall"] },
              { categories: ["exhibition", "cafe", "restaurant"], title: "가족과 조용한 관람 코스 추천!", intent: "family-browse", blocksIntents: ["culture", "quiet"] },
            ]
          : [
              { categories: ["restaurant", "cafe", "park"], title: "가족과 오후 나들이 코스 추천!", intent: "family-outing", blocksIntents: ["walk", "healing"] },
              { categories: ["nature", "restaurant", "cafe"], title: "가족과 드라이브 코스 추천!", intent: "family-drive", blocksIntents: ["landmark"] },
            ];
        case "evening": return [
          { categories: ["restaurant", "cafe", "park"], title: "가족과 저녁 산책 코스 추천!", intent: "family-evening", blocksIntents: ["healing", "terrace"] },
          { categories: ["restaurant", "cinema", "cafe"], title: "가족과 영화 코스 추천!", intent: "family-cinema", blocksIntents: ["cinema"] },
          { categories: ["mall", "restaurant", "cafe"], title: "가족과 쇼핑몰 저녁 코스 추천!", intent: "family-mall-evening", blocksIntents: ["mall"] },
        ];
        case "night": return [
          { categories: ["restaurant", "cafe"], title: "가족과 편한 야간 코스 추천!", intent: "family-night", blocksIntents: ["short"] },
        ];
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
      return [{ categories: ["restaurant", "bar", "activity"], title, intent: "featured", featured: true }];
    case "night":
      if (condition === "실내전용" || condition === "실내선호") return [{ categories: ["activity", "bar"], title, intent: "featured", featured: true }];
      // 22시 이후: activity(timeScore=30)와 bar(30)가 최고점 → activity+bar 가장 적합
      return [{ categories: ["activity", "bar"], title, intent: "featured", featured: true }];
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
