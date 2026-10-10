import {
  IST_TIMEZONE,
  IST_UTC_OFFSET_MINUTES,
  toIstDateOnly,
  istMinutesSinceMidnight,
  addDays,
  toIsoDateString,
  parseHhMmToMinutes,
  formatMinutesTo12h,
  formatHhMmTo12h,
} from './ist-date.util';

/** The UTC instant at which it is `hh:mm` IST on the given Indian date. */
function istInstant(
  year: number,
  month1: number,
  day: number,
  hh: number,
  mm = 0,
): Date {
  return new Date(
    Date.UTC(year, month1 - 1, day, hh, mm) - IST_UTC_OFFSET_MINUTES * 60_000,
  );
}

describe('ist-date.util', () => {
  it('declares Asia/Kolkata at a fixed +05:30', () => {
    expect(IST_TIMEZONE).toBe('Asia/Kolkata');
    expect(IST_UTC_OFFSET_MINUTES).toBe(330);
  });

  describe('toIstDateOnly', () => {
    it('uses the Indian calendar day, not the UTC one', () => {
      // 18:29 UTC is 23:59 IST the same day.
      expect(
        toIsoDateString(toIstDateOnly(new Date('2026-10-10T18:29:00Z'))),
      ).toBe('2026-10-10');
      // 18:30 UTC is 00:00 IST the next day.
      expect(
        toIsoDateString(toIstDateOnly(new Date('2026-10-10T18:30:00Z'))),
      ).toBe('2026-10-11');
      // 23:00 UTC is 04:30 IST the next day.
      expect(
        toIsoDateString(toIstDateOnly(new Date('2026-10-10T23:00:00Z'))),
      ).toBe('2026-10-11');
    });

    it('is stable for values that are already midnight UTC (Postgres DATE)', () => {
      for (const iso of [
        '2026-01-01',
        '2026-02-28',
        '2028-02-29',
        '2026-12-31',
      ]) {
        expect(
          toIsoDateString(toIstDateOnly(new Date(`${iso}T00:00:00Z`))),
        ).toBe(iso);
      }
    });

    it('crosses a year boundary by the Indian calendar', () => {
      // 19:00 UTC on 31 Dec is already 00:30 IST on 1 Jan.
      expect(
        toIsoDateString(toIstDateOnly(new Date('2026-12-31T19:00:00Z'))),
      ).toBe('2027-01-01');
    });

    it('returns midnight UTC', () => {
      const d = toIstDateOnly(new Date('2026-10-10T07:23:45.678Z'));
      expect(d.toISOString()).toBe('2026-10-10T00:00:00.000Z');
    });
  });

  describe('istMinutesSinceMidnight', () => {
    it('reads the Indian wall clock', () => {
      expect(istMinutesSinceMidnight(istInstant(2026, 10, 10, 0, 0))).toBe(0);
      expect(istMinutesSinceMidnight(istInstant(2026, 10, 10, 22, 59))).toBe(
        1379,
      );
      expect(istMinutesSinceMidnight(istInstant(2026, 10, 10, 23, 0))).toBe(
        1380,
      );
      expect(istMinutesSinceMidnight(istInstant(2026, 10, 10, 23, 59))).toBe(
        1439,
      );
    });

    it('maps a UTC-clock instant to the right Indian minute', () => {
      // 00:00 UTC is 05:30 IST.
      expect(istMinutesSinceMidnight(new Date('2026-10-10T00:00:00Z'))).toBe(
        330,
      );
      // 18:30 UTC is 00:00 IST.
      expect(istMinutesSinceMidnight(new Date('2026-10-10T18:30:00Z'))).toBe(0);
    });
  });

  describe('addDays', () => {
    it('steps by the calendar across month, year and leap boundaries', () => {
      const d = (iso: string) => new Date(`${iso}T00:00:00Z`);
      expect(toIsoDateString(addDays(d('2026-10-31'), 1))).toBe('2026-11-01');
      expect(toIsoDateString(addDays(d('2026-12-31'), 2))).toBe('2027-01-02');
      expect(toIsoDateString(addDays(d('2028-02-28'), 1))).toBe('2028-02-29');
      expect(toIsoDateString(addDays(d('2027-02-28'), 1))).toBe('2027-03-01');
      expect(toIsoDateString(addDays(d('2026-10-10'), 0))).toBe('2026-10-10');
    });
  });

  describe('parseHhMmToMinutes', () => {
    it('parses a valid 24h time', () => {
      expect(parseHhMmToMinutes('00:00')).toBe(0);
      expect(parseHhMmToMinutes('06:00')).toBe(360);
      expect(parseHhMmToMinutes('23:00')).toBe(1380);
      expect(parseHhMmToMinutes('23:59')).toBe(1439);
    });

    it('returns null instead of coercing malformed input to midnight', () => {
      for (const bad of [
        null,
        undefined,
        '',
        '6:00',
        '24:00',
        '23:60',
        '23',
        'oops',
      ]) {
        expect(parseHhMmToMinutes(bad as string | null)).toBeNull();
      }
    });
  });

  describe('12-hour formatting', () => {
    it('renders midnight and noon as 12, not 0', () => {
      expect(formatMinutesTo12h(0)).toBe('12:00 AM');
      expect(formatMinutesTo12h(12 * 60)).toBe('12:00 PM');
    });

    it('renders the cut-off as 11:00 PM', () => {
      expect(formatMinutesTo12h(23 * 60)).toBe('11:00 PM');
    });

    it('renders a window in AM/PM', () => {
      expect(formatHhMmTo12h('06:00')).toBe('6:00 AM');
      expect(formatHhMmTo12h('11:00')).toBe('11:00 AM');
      expect(formatHhMmTo12h('16:30')).toBe('4:30 PM');
    });

    it('returns null for an unconfigured or malformed window', () => {
      expect(formatHhMmTo12h(null)).toBeNull();
      expect(formatHhMmTo12h(undefined)).toBeNull();
      expect(formatHhMmTo12h('nope')).toBeNull();
    });
  });
});
