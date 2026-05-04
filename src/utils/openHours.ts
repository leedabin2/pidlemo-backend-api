const ALL_DAY_KEYWORDS = ["24시간", "상시"];
const KOREA_TIMEZONE = "Asia/Seoul";
const WEEKDAY_TO_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

interface TimeWindow {
  open: number;
  close: number;
}

function toMinutes(hour: string, minute: string): number {
  return parseInt(hour, 10) * 60 + parseInt(minute, 10);
}

function isWithinWindow(nowMinutes: number, window: TimeWindow): boolean {
  if (window.close === window.open) return true;
  if (window.close > window.open) {
    return nowMinutes >= window.open && nowMinutes <= window.close;
  }
  return nowMinutes >= window.open || nowMinutes <= window.close;
}

function getKoreaTimeParts(targetDate: Date): { day: number; minutes: number } {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: KOREA_TIMEZONE,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = formatter.formatToParts(targetDate);
  const weekday = parts.find((part) => part.type === "weekday")?.value ?? "Sun";
  const hour = parseInt(parts.find((part) => part.type === "hour")?.value ?? "0", 10);
  const minute = parseInt(parts.find((part) => part.type === "minute")?.value ?? "0", 10);
  return {
    day: WEEKDAY_TO_INDEX[weekday] ?? 0,
    minutes: hour * 60 + minute,
  };
}

export function parseOperatingWindows(operatingHours: string): TimeWindow[] | null {
  if (ALL_DAY_KEYWORDS.some((keyword) => operatingHours.includes(keyword))) {
    return [{ open: 0, close: 0 }];
  }

  const matches = [...operatingHours.matchAll(/(\d{2}):(\d{2})\s*-\s*(\d{2}):(\d{2})/g)];
  if (matches.length === 0) return null;

  return matches.map((match) => ({
    open: toMinutes(match[1], match[2]),
    close: toMinutes(match[3], match[4]),
  }));
}

export function getOpenStateAt(operatingHours: string, targetDate: Date): boolean | null {
  const windows = parseOperatingWindows(operatingHours);
  if (!windows) return null;

  const { minutes: nowMinutes } = getKoreaTimeParts(targetDate);
  return windows.some((window) => isWithinWindow(nowMinutes, window));
}

export function getOpenStateAtOffset(operatingHours: string, offsetMinutes: number): boolean | null {
  const targetDate = new Date(Date.now() + offsetMinutes * 60 * 1000);
  return getOpenStateAt(operatingHours, targetDate);
}

export function getOpenStateNow(operatingHours: string): boolean | null {
  return getOpenStateAt(operatingHours, new Date());
}
