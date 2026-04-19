const ALL_DAY_KEYWORDS = ["24시간", "상시"];

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

  const nowMinutes = targetDate.getHours() * 60 + targetDate.getMinutes();
  return windows.some((window) => isWithinWindow(nowMinutes, window));
}

export function getOpenStateAtOffset(operatingHours: string, offsetMinutes: number): boolean | null {
  const targetDate = new Date(Date.now() + offsetMinutes * 60 * 1000);
  return getOpenStateAt(operatingHours, targetDate);
}

export function getOpenStateNow(operatingHours: string): boolean | null {
  return getOpenStateAt(operatingHours, new Date());
}
