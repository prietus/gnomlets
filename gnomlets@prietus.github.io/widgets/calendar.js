import Clutter from 'gi://Clutter';
import Shell from 'gi://Shell';

import * as Calendar from 'resource:///org/gnome/shell/ui/calendar.js';

import {Gnomlet} from './base.js';
import * as D from '../lib/draw.js';
import * as L from '../lib/locale.js';

const DAY_MS = 86400000;

function startOfDay(d) {
    return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}


export class CalendarWidget extends Gnomlet {
    static type = 'calendar';
    static scrollable = true;
    static defaults = {events: true, days: 14};

    enable() {
        this._offset = 0; // months away from the current one
        this._events = [];
        this._weekStart = Shell.util_get_week_start?.() ?? 1;
        this._source = null;
        if (this.opts.events)
            this._startEvents();
        // repaint at midnight (and every minute so "now" stays right)
        this.aligned(60000, () => {
            this._request();
            this.host.repaint();
        });
    }

    disable() {
        super.disable();
        this._source?.destroy?.();
        this._source = null;
    }

    optsChanged() {
        if (this.opts.events && !this._source)
            this._startEvents();
        if (!this.opts.events && this._source) {
            this._source.destroy?.();
            this._source = null;
            this._events = [];
        }
    }

    _startEvents() {
        try {
            this._source = new Calendar.DBusEventSource();
            this._source.connect('changed', () => {
                this._collect();
                this.host.repaint();
            });
            this._request();
        } catch (e) {
            console.warn(`gnomlets: calendar events: ${e.message}`);
            this._source = null;
        }
    }

    _request() {
        if (!this._source)
            return;
        const begin = startOfDay(new Date());
        const end = new Date(begin.getTime() + this.opts.days * DAY_MS);
        this._range = [begin, end];
        this._source.requestRange(begin, end);
        this._collect();
    }

    _collect() {
        if (!this._source || !this._range)
            return;
        const now = new Date();
        this._events = this._source.getEvents(...this._range)
            .filter(ev => ev.end > now || ev.date.getTime() === ev.end.getTime())
            .map(ev => {
                const allDay = ev.date.getHours() === 0 && ev.date.getMinutes() === 0 &&
                    (ev.end - ev.date) % DAY_MS === 0 && ev.end - ev.date >= DAY_MS;
                return {start: ev.date, end: ev.end, summary: ev.summary, allDay};
            });
    }

    scroll(dir) {
        if (dir === Clutter.ScrollDirection.UP || dir === Clutter.ScrollDirection.LEFT)
            this._offset--;
        else if (dir === Clutter.ScrollDirection.DOWN || dir === Clutter.ScrollDirection.RIGHT)
            this._offset++;
        else
            return false;
        return true;
    }

    click(x, y) {
        for (const [kind, r] of this._hits ?? []) {
            if (x >= r[0] && x <= r[0] + r[2] && y >= r[1] && y <= r[1] + r[3]) {
                if (kind === 'prev')
                    this._offset--;
                else if (kind === 'next')
                    this._offset++;
                else if (kind === 'today')
                    this._offset = 0;
                return true;
            }
        }
        return false;
    }

    buildMenu(m) {
        m.toggle('Show events', this.opts.events, v => this.setOpt('events', v));
        if (this._offset !== 0)
            m.action('Back to this month', () => {
                this._offset = 0;
                this.host.repaint();
            });
        m.action('Open Calendar', () => {
            try {
                Shell.AppSystem.get_default().lookup_app('org.gnome.Calendar.desktop')?.activate();
            } catch {}
        });
    }

    draw(cr, w, h, t) {
        this._hits = [];
        const pad = Math.max(12, Math.min(w, h) * 0.08);
        const wide = w > h * 1.6;
        const today = new Date();

        if (w < 220 && h < 220) {
            this._drawDay(cr, pad, pad, w - pad * 2, h - pad * 2, t, today, true);
            return;
        }
        if (wide) {
            const split = Math.floor(w * 0.46);
            this._drawDay(cr, pad, pad, split - pad * 1.5, h - pad * 2, t, today, false);
            this._drawMonth(cr, split + pad * 0.5, pad, w - split - pad * 1.5, h - pad * 2, t);
            return;
        }
        // tall: month on top, events below if there is room
        const monthFull = Math.min(h - pad * 2, w * 0.85);
        const roomForEvents = this.opts.events && h > w * 0.95 && h - pad * 2 - Math.min(monthFull, h * 0.62) > 70;
        const monthH = roomForEvents ? Math.min(monthFull, h * 0.62) : h - pad * 2;
        this._drawMonth(cr, pad, pad, w - pad * 2, monthH, t);
        const restY = pad + monthH + pad * 0.6;
        if (roomForEvents) {
            D.setColor(cr, t.faint);
            cr.rectangle(pad, restY - pad * 0.3, w - pad * 2, 1);
            cr.fill();
            this._drawEvents(cr, pad, restY, w - pad * 2, h - restY - pad, t, 13);
        }
    }

    _drawDay(cr, x, y, w, h, t, today, compact) {
        const big = Math.min(h * (compact ? 0.42 : 0.38), w * 0.5);
        D.text(cr, L.DAYS[today.getDay()].toUpperCase(), x, y,
            {size: big * 0.24, weight: D.Weight.BOLD, color: t.crit, maxWidth: w, theme: t});
        D.text(cr, String(today.getDate()), x - big * 0.04, y + big * 0.28,
            {size: big, weight: D.Weight.LIGHT, color: t.fg, tnum: true, theme: t});
        const ey = y + big * 1.45;
        if (!this.opts.events || !this._source) {
            D.text(cr, `${L.cap(L.MONTHS[today.getMonth()])} ${today.getFullYear()}`, x, ey, {size: big * 0.22, color: t.dim, maxWidth: w, theme: t});
            return;
        }
        this._drawEvents(cr, x, ey, w, y + h - ey, t, Math.max(11, Math.min(14, big * 0.2)));
    }

    _drawEvents(cr, x, y, w, h, t, size) {
        const evs = this._events;
        if (!evs.length) {
            D.text(cr, this._source ? 'No upcoming events' : 'Events unavailable', x, y,
                {size, color: t.dim, maxWidth: w, theme: t});
            return;
        }
        const row = size * 2.5;
        const todayStart = startOfDay(new Date()).getTime();
        let lastDay = null;
        let cy = y;
        for (const ev of evs) {
            const day = Math.max(startOfDay(ev.start).getTime(), todayStart);
            const header = day !== lastDay;
            const need = row + (header ? size * 1.5 : 0);
            if (cy + need > y + h + 2)
                break;
            if (header) {
                const label = day === todayStart ? 'Today'
                    : day === todayStart + DAY_MS ? 'Tomorrow'
                        : L.shortDate(new Date(day));
                D.text(cr, label.toUpperCase(), x, cy, {size: size * 0.78, weight: D.Weight.BOLD, color: t.dim, theme: t});
                cy += size * 1.5;
                lastDay = day;
            }
            D.setColor(cr, t.accent);
            D.roundRect(cr, x, cy + 1, 3, row - size * 0.6, 1.5);
            cr.fill();
            D.text(cr, ev.summary || '(untitled)', x + 10, cy,
                {size, weight: D.Weight.MEDIUM, color: t.fg, maxWidth: w - 10, theme: t});
            const when = ev.allDay ? 'All day'
                : `${L.hhmm(ev.start)} – ${L.hhmm(ev.end)}`;
            D.text(cr, when, x + 10, cy + size * 1.25, {size: size * 0.85, color: t.dim, maxWidth: w - 10, tnum: true, theme: t});
            cy += row;
        }
    }

    _drawMonth(cr, x, y, w, h, t) {
        const now = new Date();
        const first = new Date(now.getFullYear(), now.getMonth() + this._offset, 1);
        const head = Math.max(12, Math.min(h * 0.1, w * 0.07));
        const title = L.cap(L.MONTHS[first.getMonth()]) + (first.getFullYear() !== now.getFullYear() || this._offset ? ` ${first.getFullYear()}` : '');
        D.text(cr, title.toUpperCase(), x + 2, y, {size: head, weight: D.Weight.BOLD, color: this._offset ? t.fg : t.crit, theme: t});

        // arrows
        const aw = head * 1.6;
        const ax = x + w - aw * 2;
        for (const [i, kind] of [[0, 'prev'], [1, 'next']]) {
            const cx = ax + aw * i + aw / 2, cy = y + head * 0.62;
            cr.setLineWidth(Math.max(1.5, head * 0.13));
            cr.setLineCap(1);
            cr.setLineJoin(1);
            D.setColor(cr, t.dim);
            const d = kind === 'prev' ? -1 : 1;
            cr.moveTo(cx - d * head * 0.15, cy - head * 0.3);
            cr.lineTo(cx + d * head * 0.15, cy);
            cr.lineTo(cx - d * head * 0.15, cy + head * 0.3);
            cr.stroke();
            this._hits.push([kind, [ax + aw * i, y - 4, aw, head * 1.5]]);
        }
        this._hits.push(['today', [x, y - 4, w - aw * 2, head * 1.5]]);

        const gy = y + head * 1.8;
        const cols = 7;
        const lead = (first.getDay() - this._weekStart + 7) % 7;
        const daysInMonth = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
        const weeks = Math.ceil((lead + daysInMonth) / 7);
        const rows = weeks + 1; // weekday names + the weeks of this month
        const cw = w / cols;
        const ch = (y + h - gy) / rows;
        const fs = Math.max(9, Math.min(ch * 0.5, cw * 0.42));

        // weekday initials
        const base = new Date(2024, 0, 7 + this._weekStart); // 2024-01-07 is a Sunday
        for (let i = 0; i < 7; i++) {
            const d = new Date(base.getTime() + i * DAY_MS);
            const name = L.DAYS_INITIAL[d.getDay()];
            const weekend = d.getDay() === 0 || d.getDay() === 6;
            D.text(cr, name, x + cw * i + cw / 2, gy + ch / 2,
                {size: fs * 0.78, weight: D.Weight.BOLD, color: weekend ? D.withAlpha(t.dim, 0.7) : t.dim, align: 'center', valign: 'middle', theme: t});
        }

        const start = new Date(first.getFullYear(), first.getMonth(), 1 - lead);
        const todayKey = startOfDay(now).getTime();
        const eventDays = new Set(this._events.map(ev => startOfDay(ev.start).getTime()));
        for (let i = 0; i < weeks * 7; i++) {
            const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
            const r = Math.floor(i / 7) + 1, c = i % 7;
            const cx = x + cw * c + cw / 2, cy = gy + ch * r + ch / 2;
            const inMonth = d.getMonth() === first.getMonth();
            const isToday = d.getTime() === todayKey;
            if (isToday) {
                D.circle(cr, cx, cy, Math.min(cw, ch) * 0.44, t.crit);
            }
            const weekend = d.getDay() === 0 || d.getDay() === 6;
            let color = isToday ? [1, 1, 1, 1] : inMonth ? weekend ? D.withAlpha(t.fg, 0.6) : t.fg : D.withAlpha(t.dim, 0.35);
            D.text(cr, String(d.getDate()), cx, cy, {
                size: fs, weight: isToday ? D.Weight.BOLD : D.Weight.MEDIUM, color,
                align: 'center', valign: 'middle', tnum: true, theme: t,
            });
            if (!isToday && eventDays.has(d.getTime()))
                D.circle(cr, cx, cy + fs * 0.75, Math.max(1.5, fs * 0.1), t.accent);
        }
    }
}
