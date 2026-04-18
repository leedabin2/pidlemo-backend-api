export interface Coordinates {
  lat: number;
  lng: number;
}

export type PlaceCategory = "cafe" | "popup" | "park" | "exhibition" | "restaurant";

export interface Place {
  id: string;
  name: string;
  category: PlaceCategory;
  coordinates: Coordinates;
  address: string;
  walkingMinutes: number;
  operatingHours: string;
  isOpen: boolean;
  representativeMenus?: { name: string; price: number }[];
  tags: string[];
  source: "kakao" | "public_data";
  score?: number;
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
  duration?: number;       // 분 단위
  indoor?: boolean;
  outdoor?: boolean;
}

export interface WeatherInfo {
  code: number;           // OpenWeather condition code
  main: string;           // Clear, Rain, Clouds ...
  description: string;
  temp: number;
  isRainy: boolean;
  isSunny: boolean;
}
