export const getCurrentTime = (): string => {
  return new Date().toISOString();
};

export const getCurrentTimeUnix = (): number => {
  return Math.floor(Date.now() / 1000);
};

export const convertDateToUnix = (date: Date): number => {
  return Math.floor(date.getTime() / 1000);
};

export const manyMinutesAgoUnix = (minutes: number): number => {
  return getCurrentTimeUnix() - minutes * 60;
};

const DAY_MS = 86_400_000;

/** An IANA zone we can actually format in, else UTC. Query params reach this, so it must never throw. */
export const safeTimeZone = (tz: string | undefined): string => {
  if (!tz) return 'UTC';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return tz;
  } catch {
    return 'UTC';
  }
};

const partsFormatter = new Map<string, Intl.DateTimeFormat>();

function formatterFor(tz: string): Intl.DateTimeFormat {
  let f = partsFormatter.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    partsFormatter.set(tz, f);
  }
  return f;
}

/** Zone offset in ms at a given instant, so DST and :30/:45 zones both land right. */
export const tzOffsetMs = (ms: number, tz: string): number => {
  const p = formatterFor(tz).formatToParts(new Date(ms));
  const get = (type: string): number => Number(p.find((x) => x.type === type)?.value ?? 0);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return asUtc - Math.floor(ms / 1000) * 1000;
};

/**
 * Midnight of `ms`'s local day in `tz`, as an epoch ms. UTC day buckets read 7 hours off in Jakarta,
 * so anything a human reads as "a day" cuts here.
 */
export const tzDayStart = (ms: number, tz: string): number => {
  const off = tzOffsetMs(ms, tz);
  const local = ms + off;
  const localMidnight = local - ((local % DAY_MS) + DAY_MS) % DAY_MS;
  // Re-read the offset AT that midnight: a DST jump between the two moments would otherwise skew the bucket.
  return localMidnight - tzOffsetMs(localMidnight - off, tz);
};

const isoDayFormatter = new Map<string, Intl.DateTimeFormat>();

/** YYYY-MM-DD as read in `tz`. en-CA is the locale that already formats that way. */
export const tzIsoDay = (ms: number, tz: string): string => {
  let f = isoDayFormatter.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
    isoDayFormatter.set(tz, f);
  }
  return f.format(new Date(ms));
};

/** Adds `n` calendar days in `tz`, so a DST day (23h or 25h) still advances exactly one bucket. */
export const tzAddDays = (dayStartMs: number, n: number, tz: string): number => tzDayStart(dayStartMs + n * DAY_MS + DAY_MS / 2, tz);
