import Cairo from 'cairo';
import Gio from 'gi://Gio';

import {Gnomlet} from './base.js';
import * as D from '../lib/draw.js';
import * as L from '../lib/locale.js';
import {getJSON} from '../lib/http.js';

const REFRESH_MS = 15 * 60 * 1000;
const RETRY_MS = 2 * 60 * 1000;

export class WeatherWidget extends Gnomlet {
    static type = 'weather';
    static defaults = {name: '', latitude: null, longitude: null, units: 'celsius'};

    enable() {
        this._data = null;
        this._error = null;
        this._cancellable = new Gio.Cancellable();
        this.onDisable(() => this._cancellable.cancel());
        this._fetch();
        this.every(REFRESH_MS, () => this._fetch());
    }

    optsChanged() {
        this._data = null;
        this._error = null;
        this._fetch();
    }

    get _configured() {
        return this.opts.latitude !== null && this.opts.longitude !== null &&
            this.opts.latitude !== undefined && this.opts.longitude !== undefined;
    }

    async _fetch() {
        if (!this._configured) {
            this.host.repaint();
            return;
        }
        const {latitude, longitude} = this.opts;
        const unit = this.opts.units === 'fahrenheit' ? '&temperature_unit=fahrenheit&wind_speed_unit=mph' : '';
        const url = 'https://api.open-meteo.com/v1/forecast' +
            `?latitude=${latitude}&longitude=${longitude}` +
            '&current=temperature_2m,apparent_temperature,weather_code,is_day,relative_humidity_2m,wind_speed_10m' +
            '&hourly=temperature_2m,weather_code,is_day' +
            '&daily=weather_code,temperature_2m_max,temperature_2m_min,sunrise,sunset' +
            `&timezone=auto&forecast_days=7${unit}`;
        try {
            this._data = await getJSON(url, this._cancellable);
            this._error = null;
        } catch (e) {
            if (this._cancellable.is_cancelled())
                return;
            this._error = e.message;
            console.warn(`gnomlets: weather: ${e.message}`);
            const id = this.every(RETRY_MS, () => {
                this.cancel(id);
                this._fetch();
            });
        }
        this.host.repaint();
    }

    click() {
        if (!this._configured) {
            this.host.manager.openPrefs(this.host.model.id);
            return true;
        }
        return false;
    }

    buildMenu(m) {
        m.action('Location…', () => this.host.manager.openPrefs(this.host.model.id));
        m.toggle('Fahrenheit', this.opts.units === 'fahrenheit',
            v => this.setOpt('units', v ? 'fahrenheit' : 'celsius'));
        m.action('Refresh now', () => this._fetch());
    }

    // --- data helpers ---

    _hourly(count) {
        const h = this._data?.hourly;
        if (!h)
            return [];
        // times are local to the location, "YYYY-MM-DDTHH:MM"
        const nowLocal = this._data.current?.time ?? '';
        let i = h.time.findIndex(t => t > nowLocal);
        if (i < 0)
            i = 0;
        const out = [];
        for (let k = i; k < h.time.length && out.length < count; k++) {
            out.push({
                hour: Number(h.time[k].slice(11, 13)),
                temp: h.temperature_2m[k],
                code: h.weather_code[k],
                isDay: h.is_day[k] === 1,
            });
        }
        return out;
    }

    _daily() {
        const d = this._data?.daily;
        if (!d)
            return [];
        return d.time.map((t, i) => {
            const [y, m, dd] = t.split('-').map(Number);
            return {
                date: new Date(y, m - 1, dd),
                code: d.weather_code[i],
                max: d.temperature_2m_max[i],
                min: d.temperature_2m_min[i],
            };
        });
    }

    // --- drawing ---

    draw(cr, w, h, t) {
        const pad = Math.max(12, Math.min(w, h) * 0.085);
        if (!this._configured) {
            this._message(cr, w, h, t, 'Weather', 'Click to choose a location');
            return;
        }
        if (!this._data) {
            this._message(cr, w, h, t, this.opts.name || 'Weather', this._error ? `Unavailable (${this._error})` : 'Loading…');
            return;
        }
        const c = this._data.current;
        const days = this._daily();
        const today = days[0];
        const deg = v => `${Math.round(v)}°`;
        const cond = D.WEATHER_TEXT[c.weather_code] ?? '';

        const small = w < 250;
        const showDaily = !small && h >= 300;
        const showHourly = !small && h >= 150;
        const name = this.opts.name || 'Here';
        const hl = today ? `H:${deg(today.max)}  L:${deg(today.min)}` : '';

        if (small) {
            // macOS small layout: city, big temperature, then icon, condition and H/L at the bottom
            const nameSize = Math.max(11, Math.min(17, h * 0.085));
            const infoSize = Math.max(10.5, Math.min(14, h * 0.075));
            const iconSize = infoSize * 1.9;
            const bottom = iconSize + infoSize * 2.8;
            const tempSize = Math.max(14, Math.min((h - pad * 2 - nameSize * 1.3 - bottom) / 1.1, w * 0.34));
            D.text(cr, name, pad, pad, {size: nameSize, weight: D.Weight.BOLD, color: t.fg, maxWidth: w - pad * 2, theme: t});
            D.text(cr, deg(c.temperature_2m), pad - tempSize * 0.04, pad + nameSize * 1.25,
                {size: tempSize, weight: D.Weight.LIGHT, color: t.fg, tnum: true, theme: t});
            const ty = h - pad - infoSize * 2.6;
            D.weatherGlyph(cr, c.weather_code, c.is_day === 1, pad + iconSize / 2, ty - iconSize / 2 - 2, iconSize, t);
            D.text(cr, cond, pad, ty, {size: infoSize, weight: D.Weight.MEDIUM, color: t.fg, maxWidth: w - pad * 2, theme: t});
            if (hl)
                D.text(cr, hl, pad, ty + infoSize * 1.35, {size: infoSize, color: t.dim, tnum: true, theme: t});
            return;
        }

        // header: city and temperature on the left; icon, condition and H/L on the right
        const headerH = showDaily ? Math.min(120, h * 0.3) : showHourly ? (h - pad * 2) * 0.5 : h - pad * 2;
        const nameSize = Math.max(11, Math.min(17, headerH * 0.17));
        const tempSize = Math.max(14, Math.min((headerH - nameSize * 1.3) / 1.12, w * 0.2));
        const infoSize = Math.max(10.5, Math.min(13.5, headerH * 0.14));
        const iconSize = Math.max(16, Math.min(headerH - infoSize * 2.9, 64));
        D.text(cr, name, pad, pad, {size: nameSize, weight: D.Weight.BOLD, color: t.fg, maxWidth: w * 0.55, theme: t});
        D.text(cr, deg(c.temperature_2m), pad - tempSize * 0.04, pad + nameSize * 1.25,
            {size: tempSize, weight: D.Weight.LIGHT, color: t.fg, tnum: true, theme: t});
        const rx = w - pad;
        D.weatherGlyph(cr, c.weather_code, c.is_day === 1, rx - iconSize / 2, pad + iconSize / 2, iconSize, t);
        const ry = pad + iconSize + 4;
        D.text(cr, cond, rx, ry, {size: infoSize, weight: D.Weight.MEDIUM, color: t.fg, align: 'right', theme: t});
        if (hl)
            D.text(cr, hl, rx, ry + infoSize * 1.35, {size: infoSize, color: t.dim, align: 'right', tnum: true, theme: t});
        let y = pad + headerH + pad * 0.5;

        // hourly row
        const hourlyH = showDaily ? Math.min(92, h - y - pad) : h - y - pad;
        if (showHourly && hourlyH >= 50) {
            const items = this._hourly(w > 420 ? 8 : 6);
            const cw = (w - pad * 2) / items.length;
            const fs = Math.max(10, Math.min(13, hourlyH * 0.17));
            items.forEach((it, i) => {
                const cx = pad + cw * i + cw / 2;
                const label = this._hour12() ? `${it.hour % 12 || 12}${it.hour < 12 ? 'AM' : 'PM'}` : `${String(it.hour).padStart(2, '0')}`;
                D.text(cr, label, cx, y, {size: fs * 0.9, weight: D.Weight.MEDIUM, color: t.dim, align: 'center', theme: t});
                D.weatherGlyph(cr, it.code, it.isDay, cx, y + hourlyH * 0.47, Math.min(cw * 0.6, hourlyH * 0.36), t);
                D.text(cr, deg(it.temp), cx, y + hourlyH - fs * 0.2, {size: fs, weight: D.Weight.MEDIUM, color: t.fg, align: 'center', valign: 'bottom', tnum: true, theme: t});
            });
            y += hourlyH + pad * 0.5;
        }
        if (!showDaily)
            return;

        // daily list
        const rowH = Math.max(22, Math.min(34, (h - y - pad) / 6));
        const rows = Math.min(days.length, Math.floor((h - y - pad) / rowH));
        if (rows >= 2) {
            D.setColor(cr, t.faint);
            cr.rectangle(pad, y - pad * 0.25, w - pad * 2, 1);
            cr.fill();
            const lo = Math.min(...days.map(d => d.min));
            const hi = Math.max(...days.map(d => d.max));
            const fs = Math.max(10.5, Math.min(14, rowH * 0.45));
            const nameW = fs * 4.2;
            const barX = pad + nameW + rowH * 1.4 + fs * 2.6;
            const barW = w - pad - fs * 2.6 - barX;
            for (let i = 0; i < rows; i++) {
                const d = days[i];
                const cy = y + rowH * i + rowH / 2;
                D.text(cr, i === 0 ? 'Today' : L.DAYS_SHORT[d.date.getDay()], pad, cy,
                    {size: fs, weight: D.Weight.MEDIUM, color: t.fg, valign: 'middle', theme: t});
                D.weatherGlyph(cr, d.code, true, pad + nameW + rowH * 0.6, cy, rowH * 0.8, t);
                D.text(cr, deg(d.min), barX - fs * 0.6, cy, {size: fs, color: t.dim, align: 'right', valign: 'middle', tnum: true, theme: t});
                D.text(cr, deg(d.max), w - pad, cy, {size: fs, weight: D.Weight.MEDIUM, color: t.fg, align: 'right', valign: 'middle', tnum: true, theme: t});
                // temperature range bar, like macOS
                const bh = Math.max(4, fs * 0.35);
                D.setColor(cr, t.faint);
                D.roundRect(cr, barX, cy - bh / 2, barW, bh, bh / 2);
                cr.fill();
                const span = Math.max(1, hi - lo);
                const x0 = barX + ((d.min - lo) / span) * barW;
                const x1 = barX + ((d.max - lo) / span) * barW;
                const grad = new Cairo.LinearGradient(barX, 0, barX + barW, 0);
                grad.addColorStopRGBA(0, 0.35, 0.75, 1, 1);
                grad.addColorStopRGBA(0.5, 1, 0.82, 0.25, 1);
                grad.addColorStopRGBA(1, 1, 0.45, 0.2, 1);
                cr.setSource(grad);
                D.roundRect(cr, x0, cy - bh / 2, Math.max(bh, x1 - x0), bh, bh / 2);
                cr.fill();
            }
        }
    }

    _hour12() {
        return !this.host.manager.use24h;
    }

    _message(cr, w, h, t, title, msg) {
        const pad = Math.max(12, Math.min(w, h) * 0.085);
        D.text(cr, title, pad, pad, {size: 15, weight: D.Weight.BOLD, color: t.fg, maxWidth: w - pad * 2, theme: t});
        D.weatherGlyph(cr, 2, true, w / 2, h / 2, Math.min(w, h) * 0.3, t);
        D.text(cr, msg, w / 2, h - pad, {size: 12, color: t.dim, align: 'center', valign: 'bottom', maxWidth: w - pad * 2, theme: t});
    }
}
