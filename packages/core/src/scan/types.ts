import type { InventoryDocument, InventoryResource } from "../model/schemas.js";

export interface ScanLogger {
  debug(message: string, metadata?: Record<string, unknown>): void;
  info(message: string, metadata?: Record<string, unknown>): void;
  warn(message: string, metadata?: Record<string, unknown>): void;
  error(message: string, metadata?: Record<string, unknown>): void;
}

export interface ScanRequest {
  readonly onRegionsResolved?: (regions: readonly string[]) => void;
  readonly onProgress?: (progress: ScanProgress) => void;
  readonly allRegions?: boolean;
  readonly globalServices?: "include" | "exclude" | "only";
  readonly resourceTypes?: readonly string[];
  readonly excludeResourceTypes?: readonly string[];
  readonly regions: readonly string[];
  readonly profile?: string;
  readonly concurrency: number;
  readonly includeManaged: boolean;
}

export interface ScanProgress {
  readonly operation: string;
  readonly region?: string;
  readonly resourceType?: string;
  readonly identifier?: string;
  readonly completed?: number;
  readonly total?: number;
}

export interface CollectorContext {
  readonly resourceTypes?: readonly string[];
  readonly accountId?: string;
  readonly region: string;
  readonly logger: ScanLogger;
}

export interface ResourceCollector {
  readonly id: string;
  readonly resourceTypes: readonly string[];
  collect(context: CollectorContext): Promise<readonly InventoryResource[]>;
}

export interface ScanEngine {
  scan(request: ScanRequest): Promise<InventoryDocument>;
}
