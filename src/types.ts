export interface Env {
  SNAPSHOTS: KVNamespace;
  FEISHU_WEBHOOK: string;
  MANUAL_RUN_SECRET?: string;
  MAX_NEW_PAGES?: string;
  MAX_SITEMAPS_PER_SITE?: string;
  MONITORED_SITEMAPS: string;
}

export interface MonitoredSite {
  id: string;
  name: string;
  url: string;
  pathPrefix?: string;
  analyzeLinkedSite?: boolean;
}

export interface Snapshot {
  sitemapUrl: string;
  scannedAt: string;
  urls: string[];
}

export interface PageAnalysis {
  url: string;
  status: number | null;
  title: string;
  h1: string;
  description: string;
  keywords: string[];
  external?: ExternalPageAnalysis;
  products?: StoreProduct[];
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

export interface SiteRunResult {
  site: MonitoredSite;
  baselineCreated: boolean;
  totalUrls: number;
  newUrls: string[];
  analyses: PageAnalysis[];
  omittedCount: number;
}
