export interface Coordinates {
  lat: number;
  lng: number;
}

export type PlaceCategory =
  | "cafe" | "popup" | "park" | "exhibition" | "restaurant" | "shopping"
  | "bar"     // 술집/바/이자카야
  | "photo"   // 포토부스
  | "nature"  // 자연 (등산·바다·오름·목장·식물원)
  | "cinema"; // 영화관

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
  subCategory?: string;
  tags: string[];
  source: "kakao" | "public_data";
  kakaoMapUrl?: string;
  score?: number;
  // Google Places 보강 정보
  googleRating?: number;          // 1.0 ~ 5.0
  googleReviewCount?: number;     // 리뷰 수
  priceLevel?: 0 | 1 | 2 | 3 | 4; // 0=무료, 1=저렴, 2=보통, 3=비쌈, 4=매우 비쌈
  photoUrl?: string;              // 대표 이미지 URL
  googleHours?: {
    isOpenNow: boolean;
    closesAtMinutesFromNow: number | null;
    periods: Array<{
      open: { day: number; time: string };
      close?: { day: number; time: string };
    }>;
  };
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
  weatherHint?: string;
  isPopular?: boolean; // 인기 코스 배지
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

// 3시간 단위 예보 엔트리
export interface ForecastEntry {
  offsetHours: number; // 현재로부터 몇 시간 뒤
  isRainy: boolean;
  isSunny: boolean;
  feelsLike: number;
}
