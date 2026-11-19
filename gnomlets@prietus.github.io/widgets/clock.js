import GLib from 'gi://GLib';

import {Gnomlet} from './base.js';
import * as D from '../lib/draw.js';
import * as L from '../lib/locale.js';

function zone(tz) {
    if (!tz)
        return GLib.TimeZone.new_local();
    try {
        return GLib.TimeZone.new_identifier(tz) ?? GLib.TimeZone.new_local();
    } catch {
        return GLib.TimeZone.new_local();
    }
}

class ClockBase extends Gnomlet {
    static defaults = {format: 'system', seconds: false, timezone: '', city: ''};

    enable() {
        this._tz = zone(this.opts.timezone);
        this._restart();
    }

    optsChanged() {
        this._tz = zone(this.opts.timezone);
        this.disable();
        this._restart();
    }

    _restart() {
        this.aligned(this.opts.seconds || this.constructor.alwaysSeconds ? 1000 : 60000,
            () => this.host.repaint());
    }

    now() {
        return GLib.DateTime.new_now(this._tz ?? zone(this.opts.timezone));
    }

    is24h() {
        return this.opts.format === 'system' ? this.host.manager.use24h : this.opts.format === '24h';
    }

    buildMenu(m) {
        m.toggle('24-hour format', this.is24h(), v => this.setOpt('format', v ? '24h' : '12h'));
        if (!this.constructor.alwaysSeconds)
            m.toggle('Show seconds', this.opts.seconds, v => this.setOpt('seconds', v));
        m.action('Time zone…', () => this.host.manager.openPrefs(this.host.model.id));
    }
}

export class DigitalClock extends ClockBase {
    static type = 'clock';

    draw(cr, w, h, t) {
        const now = this.now();
        const h24 = this.is24h();
        const time = now.format(h24
            ? this.opts.seconds ? '%H:%M:%S' : '%H:%M'
            : this.opts.seconds ? '%l:%M:%S' : '%l:%M').trim();
        const ampm = h24 ? '' : now.get_hour() < 12 ? 'AM' : 'PM';
        const date = L.longDate(now);
        const label = this.opts.city || (this.opts.timezone ? this.opts.timezone.split('/').pop().replace(/_/g, ' ') : '');

        const pad = Math.min(w, h) * 0.1;
        const chars = time.length + (ampm ? 1.4 : 0);
        let size = Math.min(h * (label ? 0.42 : 0.5), (w - pad * 2) / (chars * 0.6));
        const sub = Math.max(11, Math.min(size * 0.26, h * 0.12));
        const block = size * 1.05 + sub * 1.5 + (label ? sub * 1.4 : 0);
        let y = (h - block) / 2;

        if (label) {
            D.text(cr, label.toUpperCase(), w / 2, y, {size: sub * 0.9, weight: D.Weight.BOLD, color: t.accent, align: 'center'});
            y += sub * 1.4;
        }
        const tm = D.measure(cr, time, {size, weight: D.Weight.LIGHT, tnum: true, theme: t});
        const am = ampm ? D.measure(cr, ampm, {size: size * 0.3, weight: D.Weight.BOLD, theme: t}) : {width: 0};
        const total = tm.width + (ampm ? am.width + size * 0.08 : 0);
        const x0 = (w - total) / 2;
        D.text(cr, time, x0, y, {size, weight: D.Weight.LIGHT, color: t.fg, tnum: true, theme: t});
        if (ampm)
            D.text(cr, ampm, x0 + tm.width + size * 0.08, y + size * 0.22, {size: size * 0.3, weight: D.Weight.BOLD, color: t.dim, theme: t});
        y += size * 1.12;
        D.text(cr, date, w / 2, y, {size: sub, color: t.dim, align: 'center', maxWidth: w - pad * 2, theme: t});
    }
}

export class AnalogClock extends ClockBase {
    static type = 'analog';
    static alwaysSeconds = true;
    static defaults = {...ClockBase.defaults, seconds: true, numbers: true};

    _restart() {
        this.aligned(this.opts.seconds ? 1000 : 60000, () => this.host.repaint());
    }

    buildMenu(m) {
        m.toggle('Second hand', this.opts.seconds, v => this.setOpt('seconds', v));
        m.toggle('Numbers', this.opts.numbers, v => this.setOpt('numbers', v));
        m.action('Time zone…', () => this.host.manager.openPrefs(this.host.model.id));
    }

    draw(cr, w, h, t) {
        const now = this.now();
        const label = this.opts.city || (this.opts.timezone ? this.opts.timezone.split('/').pop().replace(/_/g, ' ') : '');
        const labelH = label ? Math.max(12, Math.min(w, h) * 0.09) : 0;
        const r = Math.min(w, h - labelH * 1.6) / 2 - Math.min(w, h) * 0.07;
        const cx = w / 2, cy = (h - labelH * 1.6) / 2 + (label ? labelH * 0.2 : 0);
        const light = t.id === 'light';
        const face = light ? [1, 1, 1, 1] : [0.08, 0.08, 0.09, 1];
        const ink = light ? [0.1, 0.1, 0.12, 1] : [0.96, 0.96, 0.97, 1];

        D.circle(cr, cx, cy, r, face);
        cr.setLineWidth(Math.max(1, r * 0.015));
        D.setColor(cr, t.border);
        cr.arc(cx, cy, r, 0, 2 * Math.PI);
        cr.stroke();

        for (let i = 0; i < 60; i++) {
            const a = (i / 60) * 2 * Math.PI;
            const major = i % 5 === 0;
            if (this.opts.numbers && major)
                continue;
            const r1 = r * (major ? 0.84 : 0.9), r2 = r * 0.95;
            cr.setLineWidth(major ? r * 0.035 : r * 0.012);
            cr.setLineCap(1);
            D.setColor(cr, major ? ink : D.withAlpha(ink, 0.45));
            cr.moveTo(cx + Math.sin(a) * r1, cy - Math.cos(a) * r1);
            cr.lineTo(cx + Math.sin(a) * r2, cy - Math.cos(a) * r2);
            cr.stroke();
        }
        if (this.opts.numbers) {
            for (let i = 1; i <= 12; i++) {
                const a = (i / 12) * 2 * Math.PI;
                D.text(cr, String(i), cx + Math.sin(a) * r * 0.78, cy - Math.cos(a) * r * 0.78,
                    {size: r * 0.2, weight: D.Weight.MEDIUM, color: ink, align: 'center', valign: 'middle', theme: t});
            }
        }
        if (r > 60) {
            const wd = `${L.DAYS_SHORT[now.get_day_of_week() % 7]} ${now.get_day_of_month()}`;
            D.text(cr, wd.toUpperCase(), cx, cy + r * 0.38,
                {size: r * 0.1, weight: D.Weight.BOLD, color: D.withAlpha(ink, 0.5), align: 'center', valign: 'middle', theme: t});
        }

        const sec = this.opts.seconds ? now.get_second() : 0;
        const min = now.get_minute() + sec / 60;
        const hr = (now.get_hour() % 12) + min / 60;
        const hand = (angle, len, width, color, tail = 0.12) => {
            cr.setLineWidth(width);
            cr.setLineCap(1);
            D.setColor(cr, color);
            cr.moveTo(cx - Math.sin(angle) * r * tail, cy + Math.cos(angle) * r * tail);
            cr.lineTo(cx + Math.sin(angle) * r * len, cy - Math.cos(angle) * r * len);
            cr.stroke();
        };
        hand((hr / 12) * 2 * Math.PI, 0.5, r * 0.075, ink, 0);
        hand((min / 60) * 2 * Math.PI, 0.76, r * 0.05, ink, 0);
        D.circle(cr, cx, cy, r * 0.06, ink);
        if (this.opts.seconds) {
            const secColor = [1, 0.62, 0.04, 1];
            hand((sec / 60) * 2 * Math.PI, 0.86, Math.max(1, r * 0.018), secColor, 0.18);
            D.circle(cr, cx, cy, r * 0.035, secColor);
            D.circle(cr, cx, cy, r * 0.014, face);
        }
        if (label) {
            D.text(cr, label.toUpperCase(), cx, h - labelH * 0.6, {
                size: labelH, weight: D.Weight.BOLD, color: t.dim, align: 'center', valign: 'bottom',
                maxWidth: w - 16, theme: t,
            });
        }
    }
}
