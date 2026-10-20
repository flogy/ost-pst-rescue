// Calendar items, tasks and contacts: reading them from Outlook items and writing standard formats:
//   appointments -> iCalendar VEVENT (.ics), including recurring series with deleted and modified occurrences
//   tasks        -> iCalendar VTODO (.ics)
//   contacts     -> vCard 3.0 (.vcf)
// Recurrence and time zone blobs are decoded according to [MS-OXOCAL] (AppointmentRecurrencePattern, TZREG).
'use strict';
const fs = require('fs');
const { PSTFile } = require('pst-extractor');
const { OutlookProperties: OP } = require('pst-extractor/dist/OutlookProperties');
const { safe, str } = require('./mailbox');

const SET = { common: OP.PSETID_Common, address: OP.PSETID_Address, appointment: OP.PSETID_Appointment, meeting: OP.PSETID_Meeting, task: PSTFile.PSETID_Task };
const LID = {
  location: 0x8208, startWhole: 0x820d, endWhole: 0x820e, subType: 0x8215, recurring: 0x8223, recur: 0x8216,
  busyStatus: 0x8205, tzStruct: 0x8233, tzDescription: 0x8234, globalObjectId: 0x0003,
  taskStart: 0x8104, taskDue: 0x8105, taskStatus: 0x8101, taskPercent: 0x8102, taskCompleted: 0x810f,
  reminderSet: 0x8503, reminderDelta: 0x8501,
};

// Which export an Outlook item class belongs to; anything else that is not mail is reported as skipped
function classify(cls) {
  if (/^IPM\.Appointment/i.test(cls)) return 'event';
  if (/^IPM\.Task(\.|$)/i.test(cls)) return 'task';
  if (/^IPM\.Contact/i.test(cls)) return 'contact';
  return null;
}
const SKIPPED = [
  [/^IPM\.DistList/i, 'contact groups (no standard format)'],
  [/^IPM\.AbchPerson/i, 'Outlook.com address book metadata (internal)'],
  [/^IPM\.StickyNote/i, 'notes (no standard format)'],
  [/^IPM\.Activity/i, 'journal entries (no standard format)'],
  [/^IPM\.TaskRequest/i, 'task assignment messages'],
  [/^IPM\.Post\.Rss/i, 'RSS feed items'],
  [/^IPM\.(Configuration|Microsoft)|^IPM\.Note\.Rules\./i, 'Outlook settings, rules and out-of-office templates (internal)'],
];
const NON_MAIL = /^IPM\.(Contact|DistList|AbchPerson|Appointment|Task|TaskRequest|StickyNote|Activity|Post\.Rss|Configuration|Microsoft)|^IPM\.Note\.Rules\./i;
const skippedReason = (cls) => (SKIPPED.find(([re]) => re.test(cls)) || [])[1] || null;

// ---------------------------------------------------------------------------
// Text formatting (RFC 5545 / RFC 2426)
// ---------------------------------------------------------------------------
const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
// fold content lines at 75 octets without splitting UTF-8 characters
function fold(line) {
  if (Buffer.byteLength(line) <= 75) return line;
  const out = [];
  let cur = '';
  let bytes = 0;
  for (const ch of line) {
    const b = Buffer.byteLength(ch);
    if (bytes + b > (out.length ? 74 : 75)) { out.push(cur); cur = ''; bytes = 0; }
    cur += ch;
    bytes += b;
  }
  out.push(cur);
  return out.join('\r\n ');
}
// every content line of a component, folded where needed (already folded lines contain CRLF and are kept)
const foldAll = (lines) => lines.filter((l) => l !== null).map((l) => (l.includes('\r\n') ? l : fold(l))).join('\r\n') + '\r\n';
const prop = (name, value) => (value === undefined || value === null || value === '' ? null : fold(`${name}:${value}`));
const two = (n) => String(n).padStart(2, '0');
const utcStamp = (d) => `${d.getUTCFullYear()}${two(d.getUTCMonth() + 1)}${two(d.getUTCDate())}T${two(d.getUTCHours())}${two(d.getUTCMinutes())}${two(d.getUTCSeconds())}Z`;
// "wall clock" dates are kept in Date objects whose UTC fields hold the local time
const localStamp = (d) => utcStamp(d).slice(0, -1);
const dateStamp = (d) => utcStamp(d).slice(0, 8);
const validDate = (d) => d instanceof Date && !isNaN(d) && d.getUTCFullYear() > 1601 && d.getUTCFullYear() < 4500;
const plainText = (msg) => {
  const t = str(safe(() => msg.body, ''));
  return t.replace(/\r\n/g, '\n').trim();
};

// ---------------------------------------------------------------------------
// Time zones (TZREG: lBias, lStandardBias, lDaylightBias, wStandardYear, stStandardDate, wDaylightYear, stDaylightDate)
// ---------------------------------------------------------------------------
function parseTzReg(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 48) return null;
  const st = (o) => ({ month: buf.readUInt16LE(o + 2), dow: buf.readUInt16LE(o + 4), week: buf.readUInt16LE(o + 6), hour: buf.readUInt16LE(o + 8), minute: buf.readUInt16LE(o + 10) });
  return { bias: buf.readInt32LE(0), stdBias: buf.readInt32LE(4), dstBias: buf.readInt32LE(8), std: st(14), dst: st(32) };
}
// n-th weekday of a month (week 5 = last) as wall-clock Date
function nthWeekday(year, month, dow, week, hour, minute) {
  if (week >= 5) {
    const last = new Date(Date.UTC(year, month, 0, hour, minute));
    last.setUTCDate(last.getUTCDate() - ((last.getUTCDay() - dow + 7) % 7));
    return last;
  }
  const first = new Date(Date.UTC(year, month - 1, 1, hour, minute));
  first.setUTCDate(1 + ((dow - first.getUTCDay() + 7) % 7) + (week - 1) * 7);
  return first;
}
// minutes to add to a wall-clock time to get UTC
function tzBias(tz, local) {
  if (!tz) return null;
  if (!tz.std.month || !tz.dst.month) return tz.bias + tz.stdBias;
  const y = local.getUTCFullYear();
  const dstStart = nthWeekday(y, tz.dst.month, tz.dst.dow, tz.dst.week, tz.dst.hour, tz.dst.minute);
  const stdStart = nthWeekday(y, tz.std.month, tz.std.dow, tz.std.week, tz.std.hour, tz.std.minute);
  const inDst = dstStart < stdStart ? local >= dstStart && local < stdStart : local >= dstStart || local < stdStart;
  return tz.bias + (inDst ? tz.dstBias : tz.stdBias);
}
const toUtc = (tz, local) => new Date(local.getTime() + tzBias(tz, local) * 60000);
const toLocal = (tz, utc) => {
  let local = new Date(utc.getTime() - (tz.bias + tz.stdBias) * 60000);
  return new Date(utc.getTime() - tzBias(tz, local) * 60000);
};
const offsetText = (minutesEast) => `${minutesEast < 0 ? '-' : '+'}${two(Math.floor(Math.abs(minutesEast) / 60))}${two(Math.abs(minutesEast) % 60)}`;
const DAY = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

function vtimezone(id, tz) {
  const std = -(tz.bias + tz.stdBias);
  const dst = -(tz.bias + tz.dstBias);
  const lines = ['BEGIN:VTIMEZONE', prop('TZID', esc(id))];
  if (!tz.std.month || !tz.dst.month) {
    lines.push('BEGIN:STANDARD', 'DTSTART:16010101T000000', `TZOFFSETFROM:${offsetText(std)}`, `TZOFFSETTO:${offsetText(std)}`, 'END:STANDARD');
  } else {
    const rule = (r) => `RRULE:FREQ=YEARLY;BYMONTH=${r.month};BYDAY=${r.week >= 5 ? -1 : r.week}${DAY[r.dow]}`;
    const start = (r) => localStamp(nthWeekday(1601, r.month, r.dow, r.week, r.hour, r.minute));
    lines.push('BEGIN:STANDARD', `DTSTART:${start(tz.std)}`, rule(tz.std), `TZOFFSETFROM:${offsetText(dst)}`, `TZOFFSETTO:${offsetText(std)}`, 'END:STANDARD');
    lines.push('BEGIN:DAYLIGHT', `DTSTART:${start(tz.dst)}`, rule(tz.dst), `TZOFFSETFROM:${offsetText(std)}`, `TZOFFSETTO:${offsetText(dst)}`, 'END:DAYLIGHT');
  }
  lines.push('END:VTIMEZONE');
  return lines;
}

// ---------------------------------------------------------------------------
// Recurrence ([MS-OXOCAL] 2.2.1.44 RecurrencePattern / AppointmentRecurrencePattern)
// ---------------------------------------------------------------------------
const fromMinutes = (m) => new Date(m * 60000 - 11644473600000); // minutes since 1601 -> wall-clock Date

function parseRecurrence(buf) {
  let o = 0;
  const u16 = () => { const v = buf.readUInt16LE(o); o += 2; return v; };
  const u32 = () => { const v = buf.readUInt32LE(o); o += 4; return v; };
  const r = {};
  o = 4; // ReaderVersion, WriterVersion
  r.frequency = u16();
  r.patternType = u16();
  r.calendarType = u16();
  r.firstDateTime = u32();
  r.period = u32();
  r.sliding = u32();
  if (r.patternType === 1) r.weekdays = u32();
  else if (r.patternType === 2 || r.patternType === 4 || r.patternType === 0xa || r.patternType === 0xc) r.day = u32();
  else if (r.patternType === 3 || r.patternType === 0xb) { r.weekdays = u32(); r.nth = u32(); }
  r.endType = u32();
  r.count = u32();
  r.firstDow = u32();
  r.deleted = Array.from({ length: u32() }, u32);
  r.modified = Array.from({ length: u32() }, u32);
  r.startDate = u32();
  r.endDate = u32();
  // AppointmentRecurrencePattern
  o += 8; // ReaderVersion2, WriterVersion2
  const writerVersion2 = buf.readUInt32LE(o - 4);
  r.startOffset = u32();
  r.endOffset = u32();
  const exceptions = [];
  const n = u16();
  for (let i = 0; i < n; i++) {
    const e = { start: u32(), end: u32(), original: u32(), flags: u16() };
    const ansi = () => { u16(); const len = u16(); const s = buf.toString('latin1', o, o + len); o += len; return s; };
    if (e.flags & 0x0001) e.subject = ansi();
    if (e.flags & 0x0002) u32();
    if (e.flags & 0x0004) u32();
    if (e.flags & 0x0008) u32();
    if (e.flags & 0x0010) e.location = ansi();
    if (e.flags & 0x0020) e.busy = u32();
    if (e.flags & 0x0040) u32();
    if (e.flags & 0x0080) e.allDay = u32();
    if (e.flags & 0x0100) u32();
    exceptions.push(e);
  }
  // ExtendedException blocks carry the Unicode subject/location; fall back to the ANSI values if anything is off
  try {
    o += 4 + buf.readUInt32LE(o); // ReservedBlock1
    for (const e of exceptions) {
      if (writerVersion2 >= 0x3009) { const size = u32(); o += size; }
      o += 4 + buf.readUInt32LE(o); // ReservedBlockEE1
      if (e.flags & 0x0011) {
        o += 12; // StartDateTime, EndDateTime, OriginalStartDate
        if (e.flags & 0x0001) { const len = u16(); e.subject = buf.toString('utf16le', o, o + len * 2); o += len * 2; }
        if (e.flags & 0x0010) { const len = u16(); e.location = buf.toString('utf16le', o, o + len * 2); o += len * 2; }
        o += 4 + buf.readUInt32LE(o); // ReservedBlockEE2
      }
    }
  } catch { /* keep ANSI values */ }
  r.exceptions = exceptions;
  return r;
}

// RRULE for a parsed pattern; null for patterns iCalendar cannot express (e.g. Hijri calendar)
function rrule(r, tz, startLocal) {
  const days = (mask) => DAY.filter((_, i) => mask & (1 << i)).join(',');
  const parts = [];
  const yearly = r.frequency === 0x200d;
  if (r.calendarType && r.calendarType !== 1) return null; // only the Gregorian calendar
  switch (r.patternType) {
    case 0:
      parts.push('FREQ=DAILY', `INTERVAL=${Math.max(1, Math.round(r.period / 1440))}`);
      break;
    case 1:
      parts.push('FREQ=WEEKLY', `INTERVAL=${Math.max(1, r.period)}`, `BYDAY=${days(r.weekdays)}`, `WKST=${DAY[r.firstDow] || 'MO'}`);
      break;
    case 2:
    case 4: {
      const day = r.patternType === 4 || r.day >= 31 ? -1 : r.day;
      if (yearly) parts.push('FREQ=YEARLY', `INTERVAL=${Math.max(1, Math.round(r.period / 12))}`, `BYMONTH=${startLocal.getUTCMonth() + 1}`);
      else parts.push('FREQ=MONTHLY', `INTERVAL=${Math.max(1, r.period)}`);
      parts.push(`BYMONTHDAY=${day}`);
      break;
    }
    case 3: {
      if (yearly) parts.push('FREQ=YEARLY', `INTERVAL=${Math.max(1, Math.round(r.period / 12))}`, `BYMONTH=${startLocal.getUTCMonth() + 1}`);
      else parts.push('FREQ=MONTHLY', `INTERVAL=${Math.max(1, r.period)}`);
      parts.push(`BYDAY=${days(r.weekdays)}`, `BYSETPOS=${r.nth >= 5 ? -1 : r.nth}`);
      break;
    }
    default:
      return null;
  }
  if (r.endType === 0x2021) {
    const until = fromMinutes(r.endDate + r.startOffset);
    parts.push(`UNTIL=${tz ? utcStamp(toUtc(tz, until)) : localStamp(until)}`);
  } else if (r.endType === 0x2022 && r.count) {
    parts.push(`COUNT=${r.count}`);
  }
  return parts.join(';');
}

// ---------------------------------------------------------------------------
// Readers: Outlook items -> plain objects (shared by the .ics/.vcf export and the HTML viewer)
// ---------------------------------------------------------------------------
function named(msg, lid, set, type) {
  const id = msg.pstFile.getNameToIdMapItem(lid, set);
  if (id === undefined || id === null || id < 0) return undefined;
  return safe(() => (type === 'date' ? msg.getDateItem(id) : type === 'binary' ? msg.getBinaryItem(id) : type === 'bool' ? msg.getBooleanItem(id)
    : type === 'int' ? (msg.pstTableItems.has(id) ? msg.getIntItem(id) : undefined) : msg.getStringItem(id)), undefined);
}

function uidOf(msg) {
  const goid = named(msg, LID.globalObjectId, SET.meeting, 'binary');
  if (Buffer.isBuffer(goid) && goid.length) return goid.toString('hex').toUpperCase();
  const key = safe(() => msg.searchKey, null);
  if (Buffer.isBuffer(key) && key.length) return key.toString('hex').toUpperCase() + '@ost-tools';
  return `${safe(() => msg.descriptorNodeId, 0)}-${utcStamp(safe(() => msg.creationTime, new Date(0)) || new Date(0))}@ost-tools`;
}

function readCommon(msg) {
  const reminder = named(msg, LID.reminderSet, SET.common, 'bool') ? Math.max(0, named(msg, LID.reminderDelta, SET.common, 'int') || 15) : null;
  return {
    uid: uidOf(msg),
    subject: str(safe(() => msg.subject, '')),
    description: plainText(msg),
    created: safe(() => msg.creationTime, null),
    modified: safe(() => msg.lastModificationTime, null),
    sensitivity: safe(() => msg.sensitivity, 0),
    importance: safe(() => msg.importance, 1),
    reminder,
  };
}

function readTimezone(msg) {
  const tz = parseTzReg(named(msg, LID.tzStruct, SET.appointment, 'binary'));
  if (!tz) return null;
  // e.g. "(UTC+01:00) Amsterdam, Berlin, Bern, ..." -> "(UTC+01.00) Amsterdam Berlin Bern ..." (TZID must not need quoting)
  const desc = str(named(msg, LID.tzDescription, SET.appointment, 'string') || '').replace(/:/g, '.').replace(/[;,"]/g, '').replace(/\s+/g, ' ').trim();
  const id = desc || `UTC${offsetText(-(tz.bias + tz.stdBias))}${tz.dst.month ? ` DST ${tz.dst.month}-${tz.dst.week} ${tz.std.month}-${tz.std.week}` : ''}`;
  return { id, tz };
}

function readEvent(msg) {
  const start = named(msg, LID.startWhole, SET.appointment, 'date') || safe(() => msg.startTime, null);
  const end = named(msg, LID.endWhole, SET.appointment, 'date') || safe(() => msg.endTime, null);
  if (!validDate(start)) throw new Error('no start time');
  const ev = {
    ...readCommon(msg),
    start,
    end: validDate(end) && end >= start ? end : start,
    allDay: named(msg, LID.subType, SET.appointment, 'bool') === true,
    location: str(named(msg, LID.location, SET.appointment, 'string') || ''),
    busy: named(msg, LID.busyStatus, SET.appointment, 'int'),
    zone: readTimezone(msg),
    organizer: null,
    attendees: [],
    pattern: null,
    recurring: named(msg, LID.recurring, SET.appointment, 'bool') === true,
  };
  const n = safe(() => msg.numberOfRecipients, 0);
  if (n) {
    const email = str(safe(() => msg.senderEmailAddress, '')) || str(safe(() => msg.sentRepresentingEmailAddress, ''));
    if (email.includes('@')) ev.organizer = { name: str(safe(() => msg.senderName, '')), email };
    for (let i = 0; i < n; i++) {
      const r = safe(() => msg.getRecipient(i), null);
      if (!r) continue;
      const mail = str(safe(() => r.smtpAddress, '')) || str(safe(() => r.emailAddress, ''));
      if (ev.organizer && mail === ev.organizer.email) continue;
      ev.attendees.push({ name: str(safe(() => r.displayName, '')), email: mail, type: safe(() => r.recipientType, 1) });
    }
  }
  if (ev.recurring) {
    const blob = named(msg, LID.recur, SET.appointment, 'binary');
    if (Buffer.isBuffer(blob) && blob.length > 50) {
      try { ev.pattern = parseRecurrence(blob); } catch { ev.pattern = null; }
    }
  }
  return ev;
}

function readTask(msg) {
  const status = safe(() => msg.taskStatus, 0);
  return {
    ...readCommon(msg),
    start: named(msg, LID.taskStart, SET.task, 'date'),
    due: named(msg, LID.taskDue, SET.task, 'date'),
    completed: named(msg, LID.taskCompleted, SET.task, 'date') || safe(() => msg.taskDateCompleted, null),
    status, // 0 not started, 1 in progress, 2 complete, 3 waiting, 4 deferred
    percent: status === 2 ? 1 : safe(() => msg.percentComplete, 0) || 0,
  };
}

function readContact(msg) {
  const g = (name) => str(safe(() => msg[name], ''));
  const c = {
    ...readCommon(msg),
    given: g('givenName'), surname: g('surname'), middle: g('middleName'), prefix: g('displayNamePrefix'), suffix: g('generation'),
    nickname: g('nickname'), company: g('companyName'), department: g('departmentName'), title: g('title'), profession: g('profession'),
    emails: [], phones: [], addresses: [], urls: [], birthday: null, anniversary: null,
  };
  c.name = g('displayName') || [c.given, c.surname].filter(Boolean).join(' ') || c.company || c.subject;
  for (const k of ['email1EmailAddress', 'email2EmailAddress', 'email3EmailAddress']) {
    const e = g(k);
    if (e && e.includes('@') && !c.emails.some((x) => x.toLowerCase() === e.toLowerCase())) c.emails.push(e);
  }
  const tel = [['businessTelephoneNumber', 'work'], ['companyMainPhoneNumber', 'work'], ['homeTelephoneNumber', 'home'], ['mobileTelephoneNumber', 'mobile'],
    ['businessFaxNumber', 'workFax'], ['homeFaxNumber', 'homeFax'], ['pagerTelephoneNumber', 'pager'], ['carTelephoneNumber', 'car'],
    ['assistantTelephoneNumber', 'assistant'], ['otherTelephoneNumber', 'other']];
  for (const [k, type] of tel) {
    const p = g(k);
    if (p && !c.phones.some((x) => x.number === p)) c.phones.push({ type, number: p });
  }
  const adr = (type, pobox, street, city, region, zip, country) => {
    if ([pobox, street, city, region, zip, country].some(Boolean)) c.addresses.push({ type, pobox, street, city, region, zip, country });
  };
  adr('work', g('workAddressPostOfficeBox') || g('businessPoBox'), g('workAddressStreet') || g('businessAddressStreet'), g('workAddressCity') || g('businessAddressCity'),
    g('workAddressState') || g('businessAddressStateOrProvince'), g('workAddressPostalCode') || g('businessPostalCode'), g('workAddressCountry') || g('businessAddressCountry'));
  adr('home', g('homeAddressPostOfficeBox'), g('homeAddressStreet'), g('homeAddressCity'), g('homeAddressStateOrProvince'), g('homeAddressPostalCode'), g('homeAddressCountry'));
  adr('other', g('otherAddressPostOfficeBox'), g('otherAddressStreet'), g('otherAddressCity'), g('otherAddressStateOrProvince'), g('otherAddressPostalCode'), g('otherAddressCountry'));
  for (const k of ['businessHomePage', 'personalHomePage']) if (g(k)) c.urls.push(g(k));
  // dates are stored as midnight of the local date; +12 h keeps the right day for any UTC offset
  const day = (d) => (validDate(d) ? dateStamp(new Date(d.getTime() + 12 * 3600000)).replace(/(\d{4})(\d\d)(\d\d)/, '$1-$2-$3') : null);
  c.birthday = day(safe(() => msg.birthday, null));
  c.anniversary = day(safe(() => msg.anniversary, null));
  return c;
}

// ---------------------------------------------------------------------------
// Occurrences of a recurring series (for the HTML calendar), in UTC; all-day ones as local dates
// ---------------------------------------------------------------------------
function occurrences(ev, rangeEnd, max = 3000) {
  const r = ev.pattern;
  const tz = ev.zone && ev.zone.tz;
  const out = [];
  const toUtcDate = (wall) => (tz ? toUtc(tz, wall) : wall);
  const duration = r.endOffset - r.startOffset;
  const deleted = new Set(r.deleted.map((m) => Math.floor(m / 1440)));
  const modified = new Map(r.exceptions.map((e) => [Math.floor(e.original / 1440), e]));
  const endDay = r.endType === 0x2021 ? Math.floor(r.endDate / 1440) : Infinity;
  const limitDay = Math.floor((rangeEnd.getTime() + 11644473600000) / 86400000);
  const startDay = Math.floor(r.startDate / 1440);
  const counted = r.endType === 0x2022 ? r.count : Infinity;
  let n = 0;
  const emit = (dayNo) => {
    if (dayNo < startDay) return true;
    if (dayNo > endDay || dayNo > limitDay || n >= counted || out.length >= max) return false;
    n++;
    if (deleted.has(dayNo) && !modified.has(dayNo)) return true;
    const e = modified.get(dayNo);
    const s = e ? e.start : dayNo * 1440 + r.startOffset;
    const en = e ? e.end : dayNo * 1440 + r.startOffset + duration;
    out.push({ start: toUtcDate(fromMinutes(s)), end: toUtcDate(fromMinutes(en)), wallStart: fromMinutes(s), wallEnd: fromMinutes(en),
      subject: e && e.subject !== undefined ? e.subject : undefined, location: e && e.location !== undefined ? e.location : undefined, changed: !!e });
    return true;
  };
  const dayOf = (y, m, d) => Math.floor((Date.UTC(y, m, d) + 11644473600000) / 86400000);
  const start = fromMinutes(r.startDate);
  const daysIn = (y, m) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  if (r.patternType === 0) {
    const step = Math.max(1, Math.round(r.period / 1440));
    for (let d = startDay; emit(d); d += step);
  } else if (r.patternType === 1) {
    // weeks start on FirstDOW; walk week by week from the week containing the start
    const first = startDay - ((start.getUTCDay() - r.firstDow + 7) % 7);
    const days = [0, 1, 2, 3, 4, 5, 6].map((i) => (r.firstDow + i) % 7).filter((d) => r.weekdays & (1 << d));
    if (!days.length) return out;
    outer: for (let w = first; ; w += 7 * Math.max(1, r.period)) {
      for (const d of days) if (!emit(w + ((d - r.firstDow + 7) % 7))) break outer;
    }
  } else if (r.patternType === 2 || r.patternType === 3 || r.patternType === 4) {
    const step = Math.max(1, r.period);
    for (let i = 0; ; i += step) {
      const y = start.getUTCFullYear() + Math.floor((start.getUTCMonth() + i) / 12);
      const m = (start.getUTCMonth() + i) % 12;
      let dayNo;
      if (r.patternType === 3) {
        const matches = [];
        for (let d = 1; d <= daysIn(y, m); d++) if (r.weekdays & (1 << new Date(Date.UTC(y, m, d)).getUTCDay())) matches.push(d);
        const pick = r.nth >= 5 ? matches[matches.length - 1] : matches[r.nth - 1];
        if (!pick) continue;
        dayNo = dayOf(y, m, pick);
      } else {
        dayNo = dayOf(y, m, r.patternType === 4 ? daysIn(y, m) : Math.min(r.day, daysIn(y, m)));
      }
      if (!emit(dayNo)) break;
      if (i > 12 * 500) break;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Writers: plain objects -> iCalendar / vCard lines
// ---------------------------------------------------------------------------
function commonLines(x) {
  const lines = [
    prop('UID', esc(x.uid)),
    prop('DTSTAMP', utcStamp(validDate(x.modified) ? x.modified : new Date())),
    validDate(x.created) ? prop('CREATED', utcStamp(x.created)) : null,
    validDate(x.modified) ? prop('LAST-MODIFIED', utcStamp(x.modified)) : null,
    prop('SUMMARY', esc(x.subject)),
    prop('DESCRIPTION', esc(x.description)),
    x.sensitivity === 2 ? 'CLASS:PRIVATE' : x.sensitivity === 3 ? 'CLASS:CONFIDENTIAL' : null,
    x.importance === 2 ? 'PRIORITY:1' : x.importance === 0 ? 'PRIORITY:9' : null,
  ];
  return lines;
}
const alarmLines = (x) => (x.reminder === null ? [] : ['BEGIN:VALARM', 'ACTION:DISPLAY', prop('DESCRIPTION', esc(x.subject || 'Reminder')), `TRIGGER:-PT${x.reminder}M`, 'END:VALARM']);

// Returns { lines: [...component lines...], extra: [[...], ...] (changed occurrences), recurring, simplified, modified }
function eventToIcs(ev) {
  const lines = ['BEGIN:VEVENT', ...commonLines(ev), prop('LOCATION', esc(ev.location))];
  if (ev.busy === 0) lines.push('TRANSP:TRANSPARENT');
  if (ev.organizer) lines.push(`ORGANIZER;CN="${ev.organizer.name.replace(/"/g, "'")}":mailto:${ev.organizer.email}`);
  for (const a of ev.attendees) {
    if (!a.email.includes('@')) continue;
    const role = { 2: 'OPT-PARTICIPANT', 3: 'NON-PARTICIPANT' }[a.type] || 'REQ-PARTICIPANT';
    lines.push(`ATTENDEE;CN="${a.name.replace(/"/g, "'")}";ROLE=${role}:mailto:${a.email}`);
  }
  const extra = [];
  const result = { lines, extra, recurring: false, simplified: false, modified: 0 };
  const p = ev.pattern;
  const zone = ev.zone;
  const rule = p ? rrule(p, zone && zone.tz, fromMinutes(p.startDate + p.startOffset)) : null;
  if (p && rule) {
    // Series: times are wall-clock times in the appointment's time zone
    result.recurring = true;
    const at = (minutes) => (ev.allDay ? `;VALUE=DATE:${dateStamp(fromMinutes(minutes))}` : zone ? `;TZID=${zone.id}:${localStamp(fromMinutes(minutes))}` : `:${localStamp(fromMinutes(minutes))}`);
    lines.push('DTSTART' + at(p.startDate + p.startOffset), 'DTEND' + at(p.startDate + p.endOffset), `RRULE:${rule}`);
    const modifiedDays = new Set(p.exceptions.map((e) => Math.floor(e.original / 1440)));
    for (const d of p.deleted) if (!modifiedDays.has(Math.floor(d / 1440))) lines.push('EXDATE' + at(d + p.startOffset));
    // Changed occurrences: separate VEVENTs with RECURRENCE-ID (their own notes and attendees are not exported)
    for (const e of p.exceptions) {
      result.modified++;
      extra.push(['BEGIN:VEVENT', prop('UID', esc(ev.uid)), prop('DTSTAMP', utcStamp(new Date())), 'RECURRENCE-ID' + at(e.original),
        'DTSTART' + at(e.start), 'DTEND' + at(e.end), prop('SUMMARY', esc(e.subject !== undefined ? e.subject : ev.subject)),
        prop('LOCATION', esc(e.location !== undefined ? e.location : ev.location)), 'END:VEVENT']);
    }
  } else {
    result.simplified = ev.recurring; // pattern not expressible: first occurrence only
    if (ev.allDay) {
      const [s, e] = allDayRange(ev);
      lines.push(`DTSTART;VALUE=DATE:${s}`, `DTEND;VALUE=DATE:${e}`);
    } else {
      lines.push(`DTSTART:${utcStamp(ev.start)}`, `DTEND:${utcStamp(ev.end)}`);
    }
  }
  lines.push(...alarmLines(ev), 'END:VEVENT');
  return result;
}

// all-day events: start/end are midnight in the creator's time zone -> local dates (end exclusive)
function allDayRange(ev) {
  const local = (d) => (ev.zone ? toLocal(ev.zone.tz, d) : new Date(d.getTime() + 12 * 3600000));
  const s = local(ev.start);
  let e = local(ev.end);
  if (dateStamp(e) <= dateStamp(s)) e = new Date(s.getTime() + 86400000);
  return [dateStamp(s), dateStamp(e)];
}

function taskToIcs(t) {
  const date = (d) => dateStamp(new Date(d.getTime() + 12 * 3600000));
  return ['BEGIN:VTODO', ...commonLines(t),
    validDate(t.start) ? `DTSTART;VALUE=DATE:${date(t.start)}` : null,
    validDate(t.due) ? `DUE;VALUE=DATE:${date(t.due)}` : null,
    `STATUS:${{ 1: 'IN-PROCESS', 2: 'COMPLETED', 4: 'CANCELLED' }[t.status] || 'NEEDS-ACTION'}`,
    `PERCENT-COMPLETE:${Math.round(t.percent * 100)}`,
    t.status === 2 && validDate(t.completed) ? `COMPLETED:${utcStamp(t.completed)}` : null,
    ...alarmLines(t), 'END:VTODO'];
}

function contactToVcf(c) {
  const v = (s) => esc(s || '');
  const TEL = { work: 'WORK,VOICE', home: 'HOME,VOICE', mobile: 'CELL,VOICE', workFax: 'WORK,FAX', homeFax: 'HOME,FAX', pager: 'PAGER', car: 'CAR', assistant: 'WORK,VOICE', other: 'VOICE' };
  const lines = ['BEGIN:VCARD', 'VERSION:3.0',
    `N:${v(c.surname)};${v(c.given)};${v(c.middle)};${v(c.prefix)};${v(c.suffix)}`,
    prop('FN', v(c.name) || 'Contact'),
    prop('NICKNAME', v(c.nickname)),
    c.company || c.department ? `ORG:${v(c.company)}${c.department ? ';' + v(c.department) : ''}` : null,
    prop('TITLE', v(c.title)),
    prop('ROLE', v(c.profession)),
    ...c.emails.map((e, i) => prop(`EMAIL;TYPE=INTERNET${i === 0 ? ',PREF' : ''}`, v(e))),
    ...c.phones.map((p) => prop(`TEL;TYPE=${TEL[p.type]}`, v(p.number))),
    ...c.addresses.map((a) => `ADR;TYPE=${{ work: 'WORK', home: 'HOME', other: 'POSTAL' }[a.type]}:${v(a.pobox)};;${v(a.street)};${v(a.city)};${v(a.region)};${v(a.zip)};${v(a.country)}`),
    ...c.urls.map((u) => prop('URL', v(u))),
    c.birthday ? `BDAY:${c.birthday}` : null,
    prop('NOTE', v(c.description)),
    validDate(c.modified) ? `REV:${utcStamp(c.modified)}` : null,
    prop('UID', v(c.uid)), 'END:VCARD'];
  return lines;
}

// ---------------------------------------------------------------------------
// Exporter
// ---------------------------------------------------------------------------
class IcsFile {
  constructor(file) {
    this.file = file;
    this.fd = null;
    this.timezones = new Map();
  }
  write(lines) {
    if (this.fd === null) {
      this.fd = fs.openSync(this.file, 'w');
      fs.writeSync(this.fd, ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//ost-tools//Outlook export//EN', 'CALSCALE:GREGORIAN', ''].join('\r\n'));
    }
    fs.writeSync(this.fd, foldAll(lines));
  }
  close() {
    if (this.fd === null) return false;
    for (const [id, tz] of this.timezones) this.write(vtimezone(id, tz));
    fs.writeSync(this.fd, 'END:VCALENDAR\r\n');
    fs.closeSync(this.fd);
    return true;
  }
}

class PimExport {
  constructor(files) {
    this.calendar = new IcsFile(files.calendar);
    this.tasks = new IcsFile(files.tasks);
    this.contactsFile = files.contacts;
    this.contactsFd = null;
    this.counts = { events: 0, recurring: 0, simplified: 0, modified: 0, tasks: 0, contacts: 0 };
    this.skipped = new Map();
    this.errors = [];
  }

  // Returns true when the item was handled (exported or counted as skipped)
  add(msg, cls, folderPath) {
    const kind = classify(cls);
    try {
      if (kind === 'event') {
        const ev = readEvent(msg);
        const ics = eventToIcs(ev);
        if (ics.recurring && ev.zone && !ev.allDay) this.calendar.timezones.set(ev.zone.id, ev.zone.tz);
        this.calendar.write(ics.lines);
        for (const e of ics.extra) this.calendar.write(e);
        this.counts.events++;
        if (ics.recurring) this.counts.recurring++;
        if (ics.simplified) this.counts.simplified++;
        this.counts.modified += ics.modified;
        return true;
      }
      if (kind === 'task') { this.tasks.write(taskToIcs(readTask(msg))); this.counts.tasks++; return true; }
      if (kind === 'contact') {
        if (this.contactsFd === null) this.contactsFd = fs.openSync(this.contactsFile, 'w');
        fs.writeSync(this.contactsFd, foldAll(contactToVcf(readContact(msg))));
        this.counts.contacts++;
        return true;
      }
    } catch (err) {
      this.errors.push(`${folderPath}: ${str(safe(() => msg.subject, ''))} (${err.message})`);
      return true;
    }
    const reason = skippedReason(cls);
    if (reason) {
      this.skipped.set(reason, (this.skipped.get(reason) || 0) + 1);
      return true;
    }
    return false;
  }

  // Closes all files; returns the list of written files
  close() {
    const written = [];
    if (this.calendar.close()) written.push({ kind: 'calendar', file: this.calendar.file });
    if (this.tasks.close()) written.push({ kind: 'tasks', file: this.tasks.file });
    if (this.contactsFd !== null) { fs.closeSync(this.contactsFd); written.push({ kind: 'contacts', file: this.contactsFile }); }
    return written;
  }
}

module.exports = { PimExport, classify, skippedReason, NON_MAIL, readEvent, readTask, readContact, occurrences, allDayRange, parseRecurrence, parseTzReg };
