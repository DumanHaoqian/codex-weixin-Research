import { Temporal } from '@js-temporal/polyfill';
import { z } from 'zod';

const timezone = z.string().min(1).max(100).refine(value => {
  try { new Intl.DateTimeFormat('en', { timeZone: value }); return !/^[+-]/.test(value); }
  catch { return false; }
}, 'Invalid IANA timezone');
const utc = z.string().refine(value => {
  try { Temporal.Instant.from(value); return value.endsWith('Z'); } catch { return false; }
}, 'Expected an ISO UTC instant');
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
export const scheduleSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('once'), atUtc: utc, timezone }).strict(),
  z.object({ kind: z.literal('daily'), time, timezone }).strict(),
  z.object({ kind: z.literal('weekly'), weekdays: z.array(z.number().int().min(1).max(7)).min(1).max(7), time, timezone }).strict(),
  z.object({ kind: z.literal('interval'), everySeconds: z.number().int().min(300).max(31_536_000), anchorUtc: utc, timezone }).strict()
]);
export type ScheduleSpec = z.infer<typeof scheduleSchema>;

export function resolveWallTime(local:string,timezone:string):string{
  const dateTime=Temporal.PlainDateTime.from(local);
  return dateTime.toZonedDateTime(timezone,{disambiguation:'reject'}).toInstant().toString();
}

// Strictly after the cursor. Wall-clock recurrences skip gaps and use the first fold.
export function nextAfter(input: ScheduleSpec, afterMs: number): number | null {
  const spec = scheduleSchema.parse(input);
  if (!Number.isSafeInteger(afterMs)) throw new Error('Invalid clock value');
  if (spec.kind === 'once') {
    const at = Temporal.Instant.from(spec.atUtc).epochMilliseconds;
    return at > afterMs ? at : null;
  }
  if (spec.kind === 'interval') {
    const anchor = Temporal.Instant.from(spec.anchorUtc).epochMilliseconds;
    const step = spec.everySeconds * 1000;
    return anchor + Math.max(0, Math.floor((afterMs - anchor) / step) + 1) * step;
  }
  const start = Temporal.Instant.fromEpochMilliseconds(afterMs).toZonedDateTimeISO(spec.timezone).toPlainDate();
  for (let offset = 0; offset < 15; offset++) {
    const date = start.add({ days: offset });
    if (spec.kind === 'weekly' && !spec.weekdays.includes(date.dayOfWeek)) continue;
    const local = date.toPlainDateTime(Temporal.PlainTime.from(spec.time));
    const fields = { timeZone: spec.timezone, year: date.year, month: date.month, day: date.day,
      hour: local.hour, minute: local.minute };
    const candidate = Temporal.ZonedDateTime.from(fields, { disambiguation: 'earlier' });
    if (!candidate.toPlainDateTime().equals(local)) continue;
    if (candidate.epochMilliseconds > afterMs) return candidate.epochMilliseconds;
  }
  throw new Error('No recurrence in the next two weeks');
}
