import axios from "axios";
import type { Coordinates, ForecastEntry, WeatherInfo } from "../types";

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

export async function getWeatherForecast(coords: Coordinates): Promise<ForecastEntry[]> {
  if (!API_KEY) return mockForecast();

  try {
    const { data } = await axios.get(`${BASE_URL}/forecast`, {
      params: {
        lat: coords.lat,
        lon: coords.lng,
        appid: API_KEY,
        units: "metric",
        cnt: 5, // 3시간 × 5 = 최대 15시간 앞
      },
    });

    const now = Date.now();
    return (data.list ?? []).slice(0, 5).map((item: Record<string, unknown>) => {
      const main = item.main as Record<string, number>;
      const weatherArr = item.weather as { id: number }[];
      const code = weatherArr[0].id;
      const offsetHours = Math.max(
        0,
        Math.round(((item.dt as number) * 1000 - now) / (1000 * 3600))
      );
      return {
        offsetHours,
        isRainy: code >= 200 && code < 700,
        isSunny: code >= 800,
        feelsLike: Math.round(main.feels_like),
      };
    });
  } catch (err) {
    console.error("[weather] forecast 오류:", err);
    return mockForecast();
  }
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

function mockForecast(): ForecastEntry[] {
  return [
    { offsetHours: 3,  isRainy: false, isSunny: true,  feelsLike: 23 },
    { offsetHours: 6,  isRainy: false, isSunny: false, feelsLike: 21 },
    { offsetHours: 9,  isRainy: false, isSunny: false, feelsLike: 19 },
  ];
}
