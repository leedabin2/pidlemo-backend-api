import axios from "axios";
import type { Coordinates, WeatherInfo } from "../types";

const API_KEY = process.env.OPENWEATHER_API_KEY ?? "";
const BASE_URL = "https://api.openweathermap.org/data/2.5";

export async function getWeather(coords: Coordinates): Promise<WeatherInfo> {
  if (!API_KEY) {
    console.warn("[weather] OPENWEATHER_API_KEY 없음 → 맑음으로 기본값 사용");
    return mockWeather();
  }

  const { data } = await axios.get(`${BASE_URL}/weather`, {
    params: {
      lat: coords.lat,
      lon: coords.lng,
      appid: API_KEY,
      units: "metric",
      lang: "kr",
    },
  });

  const code: number = data.weather[0].id;
  const main: string = data.weather[0].main;

  const feelsLike = Math.round(data.main.feels_like);
  console.log(`[weather] code=${code} temp=${Math.round(data.main.temp)}°C feelsLike=${feelsLike}°C desc=${data.weather[0].description}`);

  return {
    code,
    main,
    description: data.weather[0].description,
    temp: Math.round(data.main.temp),
    feelsLike,
    isRainy: code >= 200 && code < 700,
    isSunny: code >= 800,
  };
}

function mockWeather(): WeatherInfo {
  return {
    code: 800,
    main: "Clear",
    description: "맑음",
    temp: 22,
    feelsLike: 22,
    isRainy: false,
    isSunny: true,
  };
}
