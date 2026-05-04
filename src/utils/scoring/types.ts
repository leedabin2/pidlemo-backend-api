import type { Place, WeatherInfo, ForecastEntry } from "../../types";

export type WeatherCondition = "실내전용" | "실내선호" | "쾌적" | "야외최적";
export type TimeSlot = "dawn" | "morning" | "lunch" | "afternoon" | "evening" | "night";
export type EnvironmentPreference = "실내" | "야외" | "상관없음";
export type CompanionPreference =
  | "상관없음" | "아이와 함께" | "데이트" | "친구들과" | "직장모임" | "가족과";

export interface CourseTemplate {
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

export interface NormalizedOptions {
  selectedCategories: Place["category"][];
  environment: EnvironmentPreference;
  durationBudgetMinutes: number | null;
  weatherAware: boolean;
  transport?: "도보" | "대중교통" | "차량";
  companion: CompanionPreference;
}

export interface ScoreContext {
  weather: WeatherInfo;
  condition: WeatherCondition;
  hourOfDay: number;
  preferences: NormalizedOptions;
}

export const STAY_TIME: Record<Place["category"], number> = {
  cafe: 60,
  popup: 45,
  exhibition: 60,
  park: 50,
  restaurant: 65,
  shopping: 40,
  mall: 85,
  bar: 90,
  photo: 30,
  nature: 120,
  cinema: 130,
  activity: 90,
};

export const CATEGORY_LABEL: Record<Place["category"], string> = {
  cafe: "카페",
  popup: "팝업",
  exhibition: "전시",
  park: "공원 산책",
  restaurant: "맛집",
  shopping: "소품샵",
  mall: "쇼핑몰",
  bar: "바/이자카야",
  photo: "포토부스",
  nature: "자연",
  cinema: "영화관",
  activity: "액티비티",
};

export function isIndoorCategory(category: Place["category"]): boolean {
  return category !== "park" && category !== "nature";
}

export type { Place, WeatherInfo, ForecastEntry };
