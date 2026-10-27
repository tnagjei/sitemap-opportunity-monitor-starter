export interface Env {
  SNAPSHOTS: KVNamespace;
  FEISHU_WEBHOOK: string;
  MANUAL_RUN_SECRET?: string;
  SITEDATA_API_KEY?: string;
  TABAPI_API_KEY?: string;
  MAX_AITDK_DOMAINS_PER_RUN?: string;
  MAX_NEW_PAGES?: string;
  MAX_SITEMAPS_PER_SITE?: string;
  MONITORED_SITEMAPS: string;
  TRENDS_KEYWORDS: string;
  TRENDS_NOISE_FLOOR?: string;
  TRENDS_DOUBLING_FACTOR?: string;
  TRENDS_RETRY_DELAY_MS?: string;
}

export interface MonitoredSite {
  id: string;
  name: string;
  url: string;
  pathPrefix?: string;
  /** 重点目录，命中的页面在通知里单独标出。 */
  focusPathPrefix?: string;
  analyzeLinkedSite?: boolean;
  primaryLanguage?: string;
}

export interface Snapshot {
  sitemapUrl: string;
  scannedAt: string;
  urls: string[];
}

export interface DailyMonitorQueue {
  id: string;
  createdAt: string;
  updatedAt: string;
  status: "active" | "completed";
  startNotified: boolean;
  remainingSiteIds: string[];
  completedSiteIds: string[];
  failedSites: Record<string, string>;
  attempts: Record<string, number>;
}

export interface PageAnalysis {
  url: string;
  slug: string;
  keyword: string;
  focus?: boolean;
  status: number | null;
  title: string;
  h1: string;
  description: string;
  keywords: string[];
  external?: ExternalPageAnalysis;
  products?: StoreProduct[];
  languageVariants?: string[];
  error?: string;
}

export interface StoreProduct {
  name: string;
  price: string;
  url: string;
}

export interface ExternalPageAnalysis {
  url: string;
  status: number | null;
  title: string;
  h1: string;
  description: string;
  error?: string;
}

export interface TrendKeywordConfig {
  keyword: string;
  geo?: string;
}

export interface TrendKeywordBaseline {
  last7Mean: number;
  prev7Mean: number;
}

export interface TrendsSnapshot {
  scannedAt: string;
  keywords: Record<string, TrendKeywordBaseline>;
}

export interface TrendKeywordEvaluation {
  keyword: string;
  geo?: string;
  last7Mean: number;
  prev7Mean: number;
  multiple: number | null;
  status: "doubled" | "baseline" | "unchanged";
}

export interface TrendsReport {
  ranAt: string;
  baselineCreated: boolean;
  keywordCount: number;
  doubled: TrendKeywordEvaluation[];
  baselines: TrendKeywordEvaluation[];
  unchanged: TrendKeywordEvaluation[];
  /** Google 查不到任何数据的词，本期跳过，不影响其它词。 */
  noData: TrendKeywordConfig[];
  error?: string;
}

export interface SiteRunResult {
  site: MonitoredSite;
  baselineCreated: boolean;
  totalUrls: number;
  newUrls: string[];
  analyses: PageAnalysis[];
  omittedCount: number;
  skippedNonEnglishCount?: number;
  unmatchedNonEnglishUrls?: string[];
  primaryLanguage?: string;
  isPureMinorityLanguageSite?: boolean;
}
