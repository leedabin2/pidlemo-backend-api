export interface Coordinates {
  lat: number;
  lng: number;
}

export type PlaceCategory =
  | "cafe" | "popup" | "park" | "exhibition" | "restaurant" | "shopping" | "mall"
  | "bar"      // 술집/바/이자카야
  | "photo"    // 포토부스
  | "nature"   // 자연 (등산·바다·오름·목장·식물원)
  | "cinema"   // 영화관
  | "activity"; // 실내 액티비티 (만화카페·보드게임·방탈출·오락실)

export interface Place {
  id: string;
  name: string;
  category: PlaceCategory;
  coordinates: Coordinates;
  address: string;
  phone?: string;
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
  hasParking?: boolean;
  parkingSummary?: string;
  goodForChildren?: boolean;
  menuForChildren?: boolean;
  goodForGroups?: boolean;
  restroom?: boolean;
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
  isPopular?: boolean;
  aiReason?: string;
}

export interface RecommendQuery {
  lat: number;
  lng: number;
  categories?: PlaceCategory[];
  duration?: string;
  environment?: "실내" | "야외" | "상관없음";
  transport?: "도보" | "대중교통" | "차량";
  companion?: "상관없음" | "아이와 함께" | "데이트" | "친구들과" | "직장모임" | "가족과";
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
