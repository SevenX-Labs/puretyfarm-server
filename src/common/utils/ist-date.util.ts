/**
 * Business-calendar helpers pinned to India Standard Time.
 *
 * PuretyFarm operates in Raipur. Every "day" in the domain — a delivery date, a
 * billing period, an order cut-off — is an Indian calendar day, but the process
 * runs on Render, whose clock is UTC. Reading `Date#getHours()` or
 * `Date#getFullYear()` therefore answers a question about the *server's*
 * calendar, not the business's: at 20:00 UTC it is already the next day in
 * India, so a UTC-local helper books deliveries a day early and compares the
 * cut-off against the wrong wall clock.
 *
 * These helpers convert explicitly instead. IST is a fixed UTC+05:30 with no
 * daylight saving, so a constant offset is exact — no `Intl` lookup, no
 * zoneinfo dependency, and no behaviour that changes with `TZ`.
 */

/** Asia/Kolkata, for API responses and log lines that name the timezone. */
export const IST_TIMEZONE = "Asia/Kolkata";

/** IST is UTC+05:30 year-round (India observes no daylight saving). */
export const IST_UTC_OFFSET_MINUTES = 330;

const MINUTES_PER_DAY = 24 * 60;
const MS_PER_MINUTE = 60_000;
const MS_PER_DAY = 24 * 60 * MS_PER_MINUTE;

/**
 * Shifts an instant so that reading its UTC fields yields IST wall-clock
 * fields. Internal: the result is NOT a valid instant, only a field carrier.
 */
function toIstFields(instant: Date): Date {
  return new Date(instant.getTime() + IST_UTC_OFFSET_MINUTES * MS_PER_MINUTE);
}

/**
 * The Indian calendar date of `instant`, as midnight UTC.
 *
 * Date-only values are stored in Postgres `DATE` columns, which Prisma hands
 * back as midnight UTC; representing business dates the same way keeps
 * comparison, UTC day-stepping and `toISOString().slice(0, 10)` all exact.
 */
export function toIstDateOnly(instant: Date): Date {
  const ist = toIstFields(instant);
  return new Date(
    Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate()),
  );
}

/**
 * Minutes since IST midnight for `instant` — the business wall clock.
 * 23:00 IST is 1380 whatever the server's timezone is.
 */
export function istMinutesSinceMidnight(instant: Date): number {
  const ist = toIstFields(instant);
  return ist.getUTCHours() * 60 + ist.getUTCMinutes();
}

/**
 * Adds whole days to a date-only value.
 *
 * Steps in UTC, so it crosses month and year boundaries by the calendar rather
 * than by arithmetic on a 30-day assumption, and cannot drift on a
 * daylight-saving boundary in the server's own timezone.
 */
export function addDays(dateOnly: Date, days: number): Date {
  return new Date(dateOnly.getTime() + days * MS_PER_DAY);
}

/** `YYYY-MM-DD` for a date-only value. */
export function toIsoDateString(dateOnly: Date): string {
  return dateOnly.toISOString().slice(0, 10);
}

/** 24-hour `HH:MM` — the only accepted wire format for a time of day. */
export const HH_MM_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * Parses `HH:MM` into minutes since midnight, or null if malformed.
 *
 * Returning null rather than 0 matters: a null delivery window must surface as
 * "not configured", never as a confident "12:00 AM".
 */
export function parseHhMmToMinutes(time?: string | null): number | null {
  if (!time || !HH_MM_PATTERN.test(time)) return null;
  const [h, m] = time.split(":");
  return parseInt(h, 10) * 60 + parseInt(m, 10);
}

/** Renders minutes-since-midnight as 12-hour `h:mm AM/PM`. */
export function formatMinutesTo12h(minutes: number): string {
  const normalised = ((minutes % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  const h24 = Math.floor(normalised / 60);
  const mm = String(normalised % 60).padStart(2, "0");
  return `${h24 % 12 || 12}:${mm} ${h24 >= 12 ? "PM" : "AM"}`;
}

/** Renders a 24-hour `HH:MM` time as 12-hour `h:mm AM/PM`, or null if malformed. */
export function formatHhMmTo12h(time?: string | null): string | null {
  const minutes = parseHhMmToMinutes(time);
  return minutes === null ? null : formatMinutesTo12h(minutes);
}
