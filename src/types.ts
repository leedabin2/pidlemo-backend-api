export interface Coordinates {
  lat: number;
  lng: number;
}

export type PlaceCategory = "cafe" | "popup" | "park" | "exhibition" | "restaurant" | "shopping";

export interface Place {
  id: string;
  name: string;
  category: PlaceCategory;
  coordinates: Coordinates;
  address: string;
  walkingMinutes: number;
  operatingHours: string;
  isOpen: boolean | null;
  representativeMenus?: { name: string; price: number }[];
  subCategory?: string;  // 카카오 category_name 파싱값 (예: "한식", "커피전문점")
  tags: string[];
  source: "kakao" | "public_data";
  kakaoMapUrl?: string;
  score?: number;
}

export interface PlaceGroup {
  category: PlaceCategory;
  title: string;
  places: Place[];
}

export interface Course {
  id: string;
  title: string;
  durationMinutes: number;
  places: Place[];
  tags: string[];
}

export interface RecommendQuery {
  lat: number;
  lng: number;
  categories?: PlaceCategory[];
  duration?: string;
  environment?: "실내" | "야외" | "상관없음";
  weatherAware?: boolean;
}

export interface WeatherInfo {
  code: number;
  main: string;
  description: string;
  temp: number;
  feelsLike: number;   // 체감온도
  isRainy: boolean;
  isSunny: boolean;
}
