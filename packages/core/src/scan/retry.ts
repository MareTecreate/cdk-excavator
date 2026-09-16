export interface RetryOptions {
  readonly baseDelayMs?: number;
  readonly jitterRatio?: number;
  readonly maxAttempts?: number;
  readonly maxDelayMs?: number;
  readonly random?: () => number;
  readonly shouldRetry?: (error: unknown, failedAttempt: number) => boolean;
  readonly sleep?: (delayMs: number) => Promise<void>;
}

export interface BackoffDelayInput {
  readonly attempt: number;
  readonly baseDelayMs?: number;
  readonly jitterRatio?: number;
  readonly maxDelayMs?: number;
  readonly random?: () => number;
}

interface ResolvedRetryOptions {
  readonly baseDelayMs: number;
  readonly jitterRatio: number;
  readonly maxAttempts: number;
  readonly maxDelayMs: number;
  readonly random: () => number;
  readonly shouldRetry: (error: unknown, failedAttempt: number) => boolean;
  readonly sleep: (delayMs: number) => Promise<void>;
}

const DEFAULT_BASE_DELAY_MS = 100;
const DEFAULT_JITTER_RATIO = 0.2;
const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_MAX_DELAY_MS = 5_000;

const retryableErrorNames = new Set([
  "InternalError",
  "InternalFailure",
  "InternalServerException",
  "PriorRequestNotComplete",
  "RequestLimitExceeded",
  "RequestTimeout",
  "RequestTimeoutException",
  "ServiceUnavailable",
  "ServiceUnavailableException",
  "SlowDown",
  "Throttling",
  "ThrottlingException",
  "TooManyRequestsException",
]);

export async function retryWithBackoff<T>(
  operation: (attempt: number) => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const resolved = resolveRetryOptions(options);
  let attempt = 1;

  while (true) {
    try {
      return await operation(attempt);
    } catch (error) {
      if (
        attempt >= resolved.maxAttempts ||
        !resolved.shouldRetry(error, attempt)
      ) {
        throw error;
      }

      await resolved.sleep(
        computeBackoffDelayMs({
          attempt,
          baseDelayMs: resolved.baseDelayMs,
          jitterRatio: resolved.jitterRatio,
          maxDelayMs: resolved.maxDelayMs,
          random: resolved.random,
        }),
      );
      attempt += 1;
    }
  }
}

export function computeBackoffDelayMs(input: BackoffDelayInput): number {
  const baseDelayMs = input.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const jitterRatio = input.jitterRatio ?? DEFAULT_JITTER_RATIO;
  const maxDelayMs = input.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  const random = input.random ?? Math.random;

  validatePositiveInteger("attempt", input.attempt);
  validatePositiveInteger("baseDelayMs", baseDelayMs);
  validatePositiveInteger("maxDelayMs", maxDelayMs);

  if (jitterRatio < 0) {
    throw new Error("jitterRatio must be 0 or greater");
  }

  const exponentialDelay = Math.min(
    maxDelayMs,
    baseDelayMs * 2 ** (input.attempt - 1),
  );
  const jitterDelay = exponentialDelay * jitterRatio * random();

  return Math.min(maxDelayMs, Math.round(exponentialDelay + jitterDelay));
}

export function isRetryableError(error: unknown): boolean {
  const candidate = toErrorCandidate(error);

  if (candidate.retryable === true || candidate.awsRetryable) {
    return true;
  }

  if (
    candidate.httpStatusCode === 429 ||
    (candidate.httpStatusCode !== undefined && candidate.httpStatusCode >= 500)
  ) {
    return true;
  }

  if (candidate.name && retryableErrorNames.has(candidate.name)) {
    return true;
  }

  return candidate.message ? isRetryableMessage(candidate.message) : false;
}

function resolveRetryOptions(options: RetryOptions): ResolvedRetryOptions {
  const resolved = {
    baseDelayMs: options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS,
    jitterRatio: options.jitterRatio ?? DEFAULT_JITTER_RATIO,
    maxAttempts: options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
    maxDelayMs: options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS,
    random: options.random ?? Math.random,
    shouldRetry: options.shouldRetry ?? isRetryableError,
    sleep: options.sleep ?? defaultSleep,
  };

  validatePositiveInteger("maxAttempts", resolved.maxAttempts);
  validatePositiveInteger("baseDelayMs", resolved.baseDelayMs);
  validatePositiveInteger("maxDelayMs", resolved.maxDelayMs);

  if (resolved.jitterRatio < 0) {
    throw new Error("jitterRatio must be 0 or greater");
  }

  return resolved;
}

function defaultSleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

function validatePositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
}

interface ErrorCandidate {
  readonly awsRetryable: boolean;
  readonly httpStatusCode?: number;
  readonly message?: string;
  readonly name?: string;
  readonly retryable?: boolean;
}

function toErrorCandidate(error: unknown): ErrorCandidate {
  if (!error || typeof error !== "object") {
    return {
      awsRetryable: false,
    };
  }

  const record = error as Record<string, unknown>;
  const metadata = record["$metadata"];
  const httpStatusCode =
    metadata && typeof metadata === "object"
      ? (metadata as Record<string, unknown>)["httpStatusCode"]
      : undefined;
  const awsRetryable = Boolean(record["$retryable"]);
  const retryable = record["retryable"];

  return {
    awsRetryable,
    httpStatusCode:
      typeof httpStatusCode === "number" ? httpStatusCode : undefined,
    message: firstString(record["message"], record["Message"]),
    name: firstString(record["name"], record["code"], record["Code"]),
    retryable: typeof retryable === "boolean" ? retryable : undefined,
  };
}

function isRetryableMessage(message: string): boolean {
  return /rate exceeded|request limit|too many requests|throttl/i.test(message);
}

function firstString(...values: readonly unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }

  return undefined;
}
