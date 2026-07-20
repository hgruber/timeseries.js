// iCalendar parsing and timezone resolution (src/caldav.js).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseICS, parseICSDate } from '../src/caldav.js';

const fixture = p => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8');
const iso = ms => new Date(ms).toISOString();

const events = parseICS(fixture('../demo/fixtures/sample.ics'));
const byUid = Object.fromEntries(events.map(e => [e.uid.split('@')[0], e]));

test('parses every VEVENT in the fixture', () => {
  assert.equal(events.length, 10);
});

test('a nested VALARM does not become an event', () => {
  assert.ok(!events.some(e => /Reminder/.test(e.summary)));
  // ...and the event containing it still parses correctly.
  assert.equal(iso(byUid['with-alarm'].start), '2026-01-08T09:30:00.000Z');
});

test('folded lines are unfolded', () => {
  assert.equal(
    byUid['folded-summary'].summary,
    'A summary long enough that it is folded across two lines in the iCalendar stream',
  );
});

test('escaped TEXT characters are unescaped', () => {
  assert.equal(byUid['long-workshop'].summary, 'Two-day workshop, spans midnight');
});

test('DTEND may be given as a DURATION', () => {
  const lunch = byUid['lunch'];
  assert.equal(lunch.end - lunch.start, 45 * 60000);
});

test('VALUE=DATE events are all-day and span whole days', () => {
  const conf = byUid['allday-conf'];
  assert.equal(conf.allDay, true);
  assert.equal(conf.end - conf.start, 2 * 86400000);
});

test('a zero-length event keeps end === start', () => {
  const z = byUid['zero-length'];
  assert.equal(z.end, z.start);
});

test('TZID is resolved against the zone database', () => {
  // 09:00 Berlin in January is CET (UTC+1).
  assert.equal(iso(byUid['tz-berlin'].start), '2026-01-06T08:00:00.000Z');
});

test('zone offsets follow DST', () => {
  // Summer: CEST (UTC+2).
  assert.equal(iso(parseICSDate('20260720T120000', 'Europe/Berlin').ms), '2026-07-20T10:00:00.000Z');
  // Winter: CET (UTC+1).
  assert.equal(iso(parseICSDate('20260120T120000', 'Europe/Berlin').ms), '2026-01-20T11:00:00.000Z');
  // The hour immediately after the spring-forward gap — the case the two-pass
  // offset resolution in zoneOffset() exists for.
  assert.equal(iso(parseICSDate('20260329T030000', 'Europe/Berlin').ms), '2026-03-29T01:00:00.000Z');
});

test('a trailing Z is UTC', () => {
  assert.equal(iso(parseICSDate('20260720T120000Z').ms), '2026-07-20T12:00:00.000Z');
});

test('bad input degrades instead of throwing', () => {
  // An unknown zone falls back to floating-local rather than dropping the event.
  assert.ok(!Number.isNaN(parseICSDate('20260720T120000', 'Mars/Olympus').ms));
  assert.ok(Number.isNaN(parseICSDate('nonsense').ms));
  assert.deepEqual(parseICS(''), []);
  assert.deepEqual(parseICS('BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n'), []);
  // A VEVENT with no DTSTART has no position on the axis and is skipped.
  assert.deepEqual(parseICS('BEGIN:VEVENT\r\nSUMMARY:no start\r\nEND:VEVENT\r\n'), []);
});
