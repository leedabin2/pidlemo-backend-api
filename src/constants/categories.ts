import type { PlaceCategory } from "../types";

export const PLACE_CATEGORY_ORDER: PlaceCategory[] = [
  "cafe", "restaurant", "shopping", "mall", "popup",
  "exhibition", "park", "bar", "photo", "nature", "cinema", "activity",
];

export const CATEGORY_TITLE: Record<PlaceCategory, string> = {
  cafe: "카페",
  restaurant: "맛집",
  shopping: "감성 소품샵",
  mall: "쇼핑몰",
  popup: "팝업/행사",
  exhibition: "전시/문화",
  park: "공원 산책",
  bar: "바/이자카야",
  photo: "포토부스",
  nature: "자연",
  cinema: "영화관",
  activity: "액티비티",
};

export const CATEGORY_CANDIDATE_LIMIT: Record<PlaceCategory, number> = {
  cafe: 14,
  restaurant: 12,
  shopping: 8,
  mall: 5,
  popup: 6,
  exhibition: 10,
  park: 5,
  bar: 8,
  photo: 10,
  nature: 5,
  cinema: 8,
  activity: 8,
};
