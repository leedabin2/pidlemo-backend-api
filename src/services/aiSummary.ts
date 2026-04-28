import Anthropic from "@anthropic-ai/sdk";
import type { Course, WeatherInfo } from "../types";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY ?? "" });

const CATEGORY_KR: Record<string, string> = {
  cafe: "카페", restaurant: "맛집", shopping: "소품샵",
  popup: "팝업/행사", exhibition: "전시", park: "공원",
  bar: "바", photo: "포토부스", nature: "자연", cinema: "영화관",
};

function buildPrompt(courses: Course[], weather: WeatherInfo, hour: number): string {
  const timeLabel = hour < 6 ? "새벽" : hour < 11 ? "오전" : hour < 14 ? "점심" : hour < 17 ? "오후" : hour < 21 ? "저녁" : "밤";
  const courseLines = courses.map((c, i) => {
    const places = c.places.map((p) => `${CATEGORY_KR[p.category] ?? p.category}(${p.name}, 도보${p.walkingMinutes}분)`).join(" → ");
    return `코스${i + 1}: ${places}`;
  }).join("\n");

  return `현재 ${timeLabel} ${hour}시, 날씨: ${weather.description} ${weather.temp}°C(체감 ${weather.feelsLike}°C)

${courseLines}

각 코스마다 아래 JSON 배열 형식으로만 응답해. 설명 없이 JSON만.
[{"reason":"지금 이 코스를 가면 좋은 이유 1문장(30자 이내)"},...]`;
}

export async function generateCourseSummaries(
  courses: Course[],
  weather: WeatherInfo,
  hour: number
): Promise<string[]> {
  if (!process.env.ANTHROPIC_API_KEY || courses.length === 0) {
    return courses.map(() => "");
  }

  try {
    const message = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 512,
      messages: [{ role: "user", content: buildPrompt(courses, weather, hour) }],
    });

    const text = message.content[0].type === "text" ? message.content[0].text.trim() : "[]";
    // JSON 블록 추출
    const match = text.match(/\[[\s\S]*\]/);
    if (!match) return courses.map(() => "");

    const parsed = JSON.parse(match[0]) as { reason: string }[];
    return courses.map((_, i) => parsed[i]?.reason ?? "");
  } catch (err) {
    console.error("[aiSummary] 오류:", err);
    return courses.map(() => "");
  }
}
