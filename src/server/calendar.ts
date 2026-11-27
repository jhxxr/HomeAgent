import { randomUUID } from 'node:crypto';
import { hash, type Store } from './store.js';
import { normalizeTask, type KanbanTask } from './kanban.js';

export interface CalendarConfig {
  provider: 'none' | 'google' | 'caldav';
  calendarId?: string;
  tasksCalendarId?: string;
  accessToken?: string;
  clientId?: string;
  clientSecret?: string;
  refreshToken?: string;
  url?: string;
  tasksUrl?: string;
  username?: string;
  password?: string;
  timeZone?: string;
}
export function validateCalendarConfig(config: CalendarConfig): CalendarConfig {
  if (config.provider === 'none') return config;
  if (config.timeZone) new Intl.DateTimeFormat('en', { timeZone: config.timeZone });
  if (config.provider === 'google') {
    if (!config.accessToken && !(config.clientId && config.clientSecret && config.refreshToken)) throw new Error('Google Calendar requires an access token or OAuth refresh credentials');
    if (config.tasksCalendarId && (config.tasksCalendarId === 'primary' || config.tasksCalendarId === (config.calendarId ?? 'primary'))) throw new Error('Calendar writeback requires a separate tasks calendar');
  } else {
    if (!config.url || !config.username || !config.password) throw new Error('CalDAV requires CALENDAR_URL, CALENDAR_USERNAME and CALENDAR_PASSWORD');
    for (const raw of [config.url, config.tasksUrl].filter((value): value is string => !!value)) {
      const url = new URL(raw);
      if (url.username || url.password || url.search || url.hash || !url.pathname.endsWith('/') || url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))) throw new Error('CalDAV calendar URLs require HTTPS (or loopback), a trailing slash and no embedded credentials or query');
    }
    if (config.tasksUrl && new URL(config.tasksUrl).href === new URL(config.url).href) throw new Error('Calendar writeback requires a separate tasks calendar');
  }
  return config;
}
interface Interval { start: number; end: number }
interface CalendarSnapshot {
  source: string; syncedAt: number; from: number; until: number;
  busy: Interval[]; deadlines: Array<Interval & { title: string }>;
}
interface EventLink { id: string; signature: string; etag?: string }
const WEEK = 7 * 86400000;
const GOOGLE = 'https://www.googleapis.com/calendar/v3';
const iso = (value: number) => new Date(value).toISOString();
const utc = (value: number) => iso(value).replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const icsText = (value: string) => value.replace(/\\/g, '\\\\').replace(/\r?\n/g, '\\n').replace(/;/g, '\\;').replace(/,/g, '\\,');
const xmlText = (value: string) => value.replace(/^<!\[CDATA\[([\s\S]*)\]\]>$/, '$1')
  .replace(/&#(x[0-9a-f]+|\d+);|&(lt|gt|quot|apos|amp);/gi, (_, code: string | undefined, name: string) => {
    if (code) { const point = code[0]!.toLowerCase() === 'x' ? parseInt(code.slice(1), 16) : Number(code); return point <= 0x10ffff ? String.fromCodePoint(point) : ''; }
    return ({ lt: '<', gt: '>', quot: '"', apos: "'", amp: '&' })[name.toLowerCase() as 'lt'] ?? '';
  });

function midnight(date: string, timeZone: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('calendar_event_invalid');
  const base = Date.parse(`${date}T00:00:00Z`);
  const formatter = new Intl.DateTimeFormat('en-GB', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  let guess = base;
  for (let attempt = 0; attempt < 4; attempt++) {
    const parts = Object.fromEntries(formatter.formatToParts(guess).map(part => [part.type, part.value]));
    const observed = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
    if (observed === base) return guess;
    guess += base - observed;
  }
  throw new Error('calendar_time_zone_invalid');
}

function mergeIntervals(intervals: Interval[], from: number, until: number): Interval[] {
  const output: Interval[] = [];
  for (const item of intervals.filter(item => Number.isFinite(item.start) && Number.isFinite(item.end) && item.end > item.start && item.end > from && item.start < until).sort((a, b) => a.start - b.start)) {
    const clipped = { start: Math.max(from, item.start), end: Math.min(until, item.end) }, previous = output.at(-1);
    if (previous && previous.end >= clipped.start) previous.end = Math.max(previous.end, clipped.end);
    else output.push(clipped);
  }
  return output;
}

/** CalDAV REPORT requests expanded instances in UTC; reject unexpanded/floating data. */
export function parseCalendarData(xml: string, timeZone = 'UTC'): Array<Interval & { title: string; transparent: boolean }> {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml) || /<(?:\w+:)?(?:error|limit-recurrence-set|number-of-matches-within-limits)\b/i.test(xml)) throw new Error('calendar_response_invalid');
  if (!/<(?:[\w-]+:)?multistatus\b/.test(xml) || /HTTP\/\S+\s+(?!200\b)\d{3}/.test(xml)) throw new Error('calendar_response_invalid');
  const events: Array<Interval & { title: string; transparent: boolean }> = [];
  for (const match of xml.matchAll(/<(?:[\w-]+:)?calendar-data\b[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?calendar-data>/g)) {
    const data = xmlText(match[1]!).replace(/\r?\n[ \t]/g, '');
    for (const component of data.matchAll(/BEGIN:VEVENT\r?\n([\s\S]*?)\r?\nEND:VEVENT/g)) {
      const lines = component[1]!.split(/\r?\n/);
      if (lines.some(line => line === 'STATUS:CANCELLED')) continue;
      if (lines.some(line => /^(RRULE|RDATE|EXRULE):/.test(line))) throw new Error('calendar_recurrence_not_expanded');
      const property = (name: string) => lines.find(line => line.startsWith(`${name}:`) || line.startsWith(`${name};`));
      const date = (line: string | undefined): number => {
        if (!line) return NaN;
        const value = line.slice(line.indexOf(':') + 1);
        if (/^\d{8}$/.test(value)) return midnight(`${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`, timeZone);
        if (!/^\d{8}T\d{6}Z$/.test(value)) throw new Error('calendar_requires_utc_expansion');
        return Date.parse(`${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T${value.slice(9, 11)}:${value.slice(11, 13)}:${value.slice(13, 15)}Z`);
      };
      const startLine = property('DTSTART'), start = date(startLine);
      let end = date(property('DTEND'));
      const duration = property('DURATION')?.match(/^DURATION:P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/);
      if (!Number.isFinite(end) && duration) end = start + (Number(duration[1] ?? 0) * 604800 + Number(duration[2] ?? 0) * 86400 + Number(duration[3] ?? 0) * 3600 + Number(duration[4] ?? 0) * 60 + Number(duration[5] ?? 0)) * 1000;
      if (!Number.isFinite(end)) end = start + (startLine?.includes('VALUE=DATE:') ? 86400000 : 1);
      if (!Number.isFinite(start) || end <= start) throw new Error('calendar_event_invalid');
      const summary = property('SUMMARY') ?? 'SUMMARY:';
      const title = summary.slice(summary.indexOf(':') + 1).replace(/\\n/gi, '\n').replace(/\\([,;\\])/g, '$1').slice(0, 256);
      events.push({ start, end, title, transparent: property('TRANSP') === 'TRANSP:TRANSPARENT' });
      if (events.length > 10000) throw new Error('calendar_response_limit');
    }
  }
  return events;
}

/** Optional, single-flight adapter. Only busy times and explicitly tagged deadlines are cached. */
export class Calendar {
  private timer?: NodeJS.Timeout;
  private scheduled?: NodeJS.Timeout;
  private pending?: Promise<void>;
  private closed = false;
  private abort = new AbortController();
  private lastAttempt = 0;
  private accessToken?: string;
  private tokenExpires = 0;
  readonly source: string;
  constructor(private store: Store, readonly config: CalendarConfig = { provider: 'none' }, private request: typeof fetch = fetch) {
    validateCalendarConfig(config);
    this.source = hash(JSON.stringify([config.provider, config.calendarId, config.url, config.tasksCalendarId, config.tasksUrl, config.timeZone]));
    this.accessToken = config.accessToken;
  }
  start() {
    if (this.config.provider === 'none') return;
    this.requestSync();
    this.timer = setInterval(() => this.requestSync(), 60000).unref();
  }
  requestSync() {
    if (this.closed || this.config.provider === 'none' || this.scheduled || this.pending) return;
    this.scheduled = setTimeout(() => { this.scheduled = undefined; void this.sync(); }, Math.max(100, this.lastAttempt + 10000 - Date.now())).unref();
  }
  context() {
    if (this.config.provider === 'none') return { enabled: false, provider: 'none', status: 'disabled', busy: [], free: [], deadlines: [] };
    const snapshot = this.store.get<CalendarSnapshot>('calendarCache', `context:${this.source}`);
    const failure = this.store.get<{ at: number; error: string }>('calendarCache', `error:${this.source}`);
    const from = Date.now(), until = from + WEEK;
    const fresh = !!snapshot && from - snapshot.syncedAt <= 5 * 60000 && snapshot.until >= until - 5 * 60000;
    const busy = mergeIntervals(snapshot?.busy ?? [], from, Math.min(until, snapshot?.until ?? from));
    const free: Interval[] = [];
    // A stale/failed sync must never advertise unknown time as available.
    if (fresh && (!failure || failure.at < snapshot!.syncedAt)) {
      let cursor = from;
      for (const item of busy) { if (cursor < item.start) free.push({ start: cursor, end: item.start }); cursor = item.end; }
      if (cursor < snapshot!.until) free.push({ start: cursor, end: snapshot!.until });
    }
    return { enabled: true, provider: this.config.provider, status: failure && (!snapshot || failure.at >= snapshot.syncedAt) ? 'error' : fresh ? 'synced' : 'stale',
      syncedAt: snapshot?.syncedAt ?? null, from, until: snapshot?.until ?? until, busy, free,
      deadlines: snapshot?.deadlines.filter(event => event.end > from && event.start < until) ?? [],
      error: failure?.error ?? null, writebackEnabled: this.config.provider === 'google' || !!this.config.tasksUrl };
  }
  sync(): Promise<void> {
    if (this.closed || this.config.provider === 'none') return Promise.resolve();
    if (this.pending) return this.pending;
    this.lastAttempt = Date.now();
    this.pending = this.performSync().catch(error => {
      if (!this.closed) this.store.put('calendarCache', `error:${this.source}`, { at: Date.now(), error: error instanceof CalendarError ? error.code : 'calendar_sync_failed' });
    }).finally(() => { this.pending = undefined; });
    return this.pending;
  }
  private async text(url: string, init: RequestInit = {}) {
    const response = await this.request(url, { ...init, redirect: 'error', signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(15000)]) });
    const maximum = 4 * 1024 * 1024;
    if (Number(response.headers.get('content-length')) > maximum) { await response.body?.cancel(); throw new CalendarError('calendar_response_limit'); }
    const reader = response.body?.getReader();
    let size = 0; const chunks: Uint8Array[] = [];
    if (reader) for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > maximum) { await reader.cancel(); throw new CalendarError('calendar_response_limit'); }
      chunks.push(value);
    }
    return { response, text: Buffer.concat(chunks).toString('utf8') };
  }
  private async google(path: string, init: RequestInit = {}, allowed: number[] = []) {
    if (this.config.refreshToken && (!this.accessToken || this.tokenExpires <= Date.now())) {
      const token = await this.text('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: this.config.refreshToken, client_id: this.config.clientId!, client_secret: this.config.clientSecret! }) });
      if (!token.response.ok) throw new CalendarError('calendar_auth_failed');
      const data = JSON.parse(token.text) as { access_token: string; expires_in: number };
      if (!data.access_token || !Number.isFinite(data.expires_in)) throw new CalendarError('calendar_auth_failed');
      this.accessToken = data.access_token; this.tokenExpires = Date.now() + Math.max(1, data.expires_in - 60) * 1000;
    }
    const output = await this.text(`${GOOGLE}${path}`, { ...init, headers: { authorization: `Bearer ${this.accessToken}`, 'content-type': 'application/json', ...init.headers } });
    if (!output.response.ok && !allowed.includes(output.response.status)) { if (output.response.status === 401) this.tokenExpires = 0; throw new CalendarError(`calendar_http_${output.response.status}`); }
    return { status: output.response.status, data: output.text && output.response.ok ? JSON.parse(output.text) as Record<string, any> : {} };
  }
  private async caldav(url: string, init: RequestInit = {}, allowed: number[] = []) {
    const output = await this.text(url, { ...init, headers: { authorization: `Basic ${Buffer.from(`${this.config.username}:${this.config.password}`).toString('base64')}`, ...init.headers } });
    if (!output.response.ok && !allowed.includes(output.response.status)) throw new CalendarError(`calendar_http_${output.response.status}`);
    return output;
  }
  private async read(from: number, until: number) {
    if (this.config.provider === 'caldav') {
      const body = `<C:calendar-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><D:prop><C:calendar-data><C:expand start="${utc(from)}" end="${utc(until)}"/></C:calendar-data></D:prop><C:filter><C:comp-filter name="VCALENDAR"><C:comp-filter name="VEVENT"><C:time-range start="${utc(from)}" end="${utc(until)}"/></C:comp-filter></C:comp-filter></C:filter></C:calendar-query>`;
      const output = await this.caldav(this.config.url!, { method: 'REPORT', headers: { depth: '1', 'content-type': 'application/xml; charset=utf-8' }, body });
      return parseCalendarData(output.text, this.config.timeZone ?? 'UTC');
    }
    const events: Array<Interval & { title: string; transparent: boolean }> = [];
    let pageToken: string | undefined;
    for (let page = 0; page < 10; page++) {
      const query = new URLSearchParams({ timeMin: iso(from), timeMax: iso(until), singleEvents: 'true', maxResults: '1000', ...(pageToken ? { pageToken } : {}) });
      const { data } = await this.google(`/calendars/${encodeURIComponent(this.config.calendarId ?? 'primary')}/events?${query}`);
      if (!Array.isArray(data.items)) throw new CalendarError('calendar_response_invalid');
      for (const event of data.items) {
        if (event.status === 'cancelled') continue;
        const timeZone = data.timeZone ?? this.config.timeZone;
        const eventTime = (value: { dateTime?: string; date?: string } | undefined) => value?.dateTime ? Date.parse(value.dateTime)
          : value?.date && timeZone ? midnight(value.date, timeZone) : NaN;
        const start = eventTime(event.start), end = eventTime(event.end);
        if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) throw new CalendarError('calendar_event_invalid');
        events.push({ start, end, title: String(event.summary ?? '').slice(0, 256), transparent: event.transparency === 'transparent' });
      }
      pageToken = data.nextPageToken;
      if (!pageToken) return events;
    }
    throw new CalendarError('calendar_response_limit');
  }
  private async tasksCalendar() {
    if (this.config.tasksCalendarId) return this.config.tasksCalendarId;
    const key = `googleTasks:${this.source}`, cached = this.store.get<{ id: string }>('calendarCache', key);
    if (cached) return cached.id;
    const { data } = await this.google('/calendars', { method: 'POST', body: JSON.stringify({ summary: 'HomeAgent Tasks', description: 'Task deadlines and human review reminders managed by HomeAgent.' }) });
    if (typeof data.id !== 'string') throw new CalendarError('calendar_response_invalid');
    this.store.put('calendarCache', key, { id: data.id }); return data.id;
  }
  private async writeTask(task: KanbanTask, calendarId: string | null, instance: string) {
    const key = `event:${this.source}:${task.id}`, link = this.store.get<EventLink>('calendarCache', key);
    const wanted = task.status !== 'done' && (!!task.dueAt || task.riskLevel === 'high' && task.status === 'review');
    if (!wanted && !link) return;
    const id = link?.id ?? `ha${hash(`${instance}:${task.id}`)}`;
    const start = task.dueAt ?? task.updatedAt, end = start + 15 * 60000;
    const title = `${task.riskLevel === 'high' && task.status === 'review' ? '[REVIEW]' : '[DDL]'} ${task.id} ${task.title}`;
    const signature = hash(JSON.stringify([title, start, task.status, task.riskLevel]));
    if (wanted && link?.signature === signature) return;
    let etag: string | undefined;
    if (this.config.provider === 'google') {
      const base = `/calendars/${encodeURIComponent(calendarId!)}/events`;
      if (!wanted) await this.google(`${base}/${encodeURIComponent(id)}`, { method: 'DELETE' }, [404, 410]);
      else {
        const event = { summary: title, start: { dateTime: iso(start) }, end: { dateTime: iso(end) }, transparency: 'transparent', reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 0 }] }, description: `HomeAgent ${task.id} · ${task.status} · ${task.riskLevel}`, extendedProperties: { private: { homeagentTask: task.id, homeagentInstance: instance } } };
        if (link) {
          const updated = await this.google(`${base}/${id}`, { method: 'PATCH', body: JSON.stringify(event) }, [404, 410]);
          if ([404, 410].includes(updated.status)) await this.google(base, { method: 'POST', body: JSON.stringify({ ...event, id }) });
        } else {
          const created = await this.google(base, { method: 'POST', body: JSON.stringify({ ...event, id }) }, [409]);
          if (created.status === 409) await this.google(`${base}/${id}`, { method: 'PATCH', body: JSON.stringify(event) });
        }
      }
    } else {
      const url = new URL(`${id}.ics`, this.config.tasksUrl!).href;
      if (!wanted) await this.caldav(url, { method: 'DELETE', headers: link?.etag ? { 'if-match': link.etag } : {} }, [404, 410]);
      else {
        const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//HomeAgent//Tasks//EN', 'BEGIN:VEVENT', `UID:${id}@homeagent`, `DTSTAMP:${utc(Date.now())}`, `DTSTART:${utc(start)}`, `DTEND:${utc(end)}`, `SUMMARY:${icsText(title)}`, 'TRANSP:TRANSPARENT', 'BEGIN:VALARM', 'ACTION:DISPLAY', 'TRIGGER:PT0S', `DESCRIPTION:${icsText(title)}`, 'END:VALARM', 'END:VEVENT', 'END:VCALENDAR'];
        // Fold at UTF-8 octet boundaries, including continuation spaces (RFC 5545).
        const folded = lines.map(line => { let out = '', width = 0; for (const ch of line) { const bytes = Buffer.byteLength(ch); if (width + bytes > 74) { out += '\r\n '; width = 1; } out += ch; width += bytes; } return out; }).join('\r\n') + '\r\n';
        const output = await this.caldav(url, { method: 'PUT', headers: { 'content-type': 'text/calendar; charset=utf-8', ...(link?.etag ? { 'if-match': link.etag } : !link ? { 'if-none-match': '*' } : {}) }, body: folded });
        etag = output.response.headers.get('etag') ?? undefined;
      }
    }
    if (this.closed) return;
    if (wanted) this.store.put('calendarCache', key, { id, signature, etag }); else this.store.delete('calendarCache', key);
    const current = this.store.get<KanbanTask>('tasks', task.id);
    if (current) { current.calendarEventId = wanted ? id : null; this.store.put('tasks', current.id, current); }
  }
  private async performSync() {
    const from = Date.now(), until = from + WEEK;
    const events = await this.read(from, until);
    if (this.closed) return;
    this.store.put('calendarCache', `context:${this.source}`, { source: this.source, syncedAt: Date.now(), from, until,
      busy: mergeIntervals(events.filter(event => !event.transparent), from, until),
      deadlines: events.filter(event => /\[DDL\]/i.test(event.title)).map(({ start, end, title }) => ({ start, end, title })),
    } satisfies CalendarSnapshot);
    const tasks = this.store.all<KanbanTask>('tasks').map(normalizeTask);
    if (this.config.provider === 'google' || this.config.tasksUrl) {
      let instance = this.store.get<{ id: string }>('calendarCache', 'instance')?.id;
      if (!instance) { instance = randomUUID(); this.store.put('calendarCache', 'instance', { id: instance }); }
      const pending = tasks.filter(task => task.calendarEventId || task.status !== 'done' && (task.dueAt || task.riskLevel === 'high' && task.status === 'review'));
      const calendarId = this.config.provider === 'google' && pending.length ? await this.tasksCalendar() : null;
      for (const task of pending) { if (this.closed) return; await this.writeTask(task, calendarId, instance); }
    }
    if (!this.closed) this.store.delete('calendarCache', `error:${this.source}`);
  }
  async close() {
    this.closed = true; this.abort.abort(); clearInterval(this.timer); clearTimeout(this.scheduled);
    await this.pending;
  }
}
class CalendarError extends Error { constructor(readonly code: string) { super(code); } }
