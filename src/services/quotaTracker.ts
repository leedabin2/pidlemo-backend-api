type QuotaSku =
  | "google_find_place_legacy_pro"
  | "google_place_details_legacy_pro"
  | "google_routes_essentials"
  | "google_place_details_enterprise_atmosphere"
  | "google_text_search_new"
  | "google_nearby_search_new";

interface QuotaConfig {
  label: string;
  freeCap: number;
}

export interface QuotaUsageSnapshotItem {
  sku: QuotaSku;
  label: string;
  freeCap: number;
  used: number;
  remainingFree: number;
}

const QUOTA_CONFIG: Record<QuotaSku, QuotaConfig> = {
  google_find_place_legacy_pro: {
    label: "Google Find Place Legacy(Pro)",
    freeCap: 5000,
  },
  google_place_details_legacy_pro: {
    label: "Google Place Details Legacy(Pro)",
    freeCap: 5000,
  },
  google_routes_essentials: {
    label: "Google Routes Essentials",
    freeCap: 10000,
  },
  google_place_details_enterprise_atmosphere: {
    label: "Google Place Details Enterprise+Atmosphere",
    freeCap: 1000,
  },
  google_text_search_new: {
    label: "Google Text Search (New API Basic)",
    freeCap: 3000,
  },
  google_nearby_search_new: {
    label: "Google Nearby Search (New API Basic)",
    freeCap: 3000,
  },
};

const usageStore = new Map<string, number>();

function getMonthKey(now = new Date()): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
}

function usageKey(sku: QuotaSku, now = new Date()): string {
  return `${getMonthKey(now)}:${sku}`;
}

export function recordQuotaUsage(sku: QuotaSku, count = 1): void {
  const key = usageKey(sku);
  const current = usageStore.get(key) ?? 0;
  usageStore.set(key, current + count);
}

export function getQuotaUsageSnapshot(): QuotaUsageSnapshotItem[] {
  return Object.entries(QUOTA_CONFIG).map(([sku, config]) => {
    const used = usageStore.get(usageKey(sku as QuotaSku)) ?? 0;
    return {
      sku: sku as QuotaSku,
      label: config.label,
      freeCap: config.freeCap,
      used,
      remainingFree: Math.max(0, config.freeCap - used),
    };
  });
}

export function diffQuotaUsage(
  before: QuotaUsageSnapshotItem[],
  after: QuotaUsageSnapshotItem[],
): QuotaUsageSnapshotItem[] {
  const beforeMap = new Map(before.map((item) => [item.sku, item]));
  return after.map((item) => {
    const previous = beforeMap.get(item.sku);
    const used = item.used - (previous?.used ?? 0);
    return {
      ...item,
      used,
      remainingFree: Math.max(0, item.freeCap - used),
    };
  });
}

export function logQuotaUsageSnapshot(prefix = "[quota]"): void {
  const month = getMonthKey();
  for (const item of getQuotaUsageSnapshot()) {
    logger.info("quota", `${prefix} ${item.label}`, {
      month,
      remaining: `${item.remainingFree}/${item.freeCap}`,
      used: item.used,
    });
  }
}
import { logger } from "../utils/logger";
