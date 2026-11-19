import GLib from 'gi://GLib';

import {Gnomlet} from './base.js';
import * as D from '../lib/draw.js';
import * as Sys from '../lib/sysinfo.js';

function levelColor(frac, t) {
    return frac > 0.9 ? t.crit : frac > 0.7 ? t.warn : null;
}

function pct(v) {
    return `${Math.round(v * 100)}%`;
}

function title(cr, label, x, y, w, t, size = 12) {
    D.text(cr, label.toUpperCase(), x, y, {size, weight: D.Weight.BOLD, color: t.dim, maxWidth: w, theme: t});
}

function subscribe(widget, sampler) {
    const unsub = sampler.subscribe(s => {
        widget.sample = s;
        widget.host.repaint();
    });
    widget.onDisable(unsub);
}

// --- CPU & memory -----------------------------------------------------------

export class SystemWidget extends Gnomlet {
    static type = 'system';

    enable() {
        subscribe(this, Sys.system());
    }

    draw(cr, w, h, t) {
        const s = this.sample;
        if (!s)
            return;
        const pad = Math.max(12, Math.min(w, h) * 0.08);
        const fs = Math.max(10.5, Math.min(14, Math.min(w, h) * 0.075));
        const gauges = [
            {label: 'CPU', frac: s.cpu, color: levelColor(s.cpu, t) ?? t.accent,
                sub: s.temp !== null ? `${Math.round(s.temp)}°C` : `load ${s.load[0].toFixed(2)}`},
            {label: 'Memory', frac: s.mem.frac, color: levelColor(s.mem.frac, t) ?? t.accent2,
                sub: D.formatBytes(s.mem.used)},
        ];
        const wide = w > h * 1.5;
        let gx = pad, gy = pad, gw = w - pad * 2, gh = h - pad * 2;
        let rest = null;
        if (wide && w > 300) {
            gw = Math.min(gw, gh * 2.1);
            rest = {x: pad + gw + pad, y: pad, w: w - gw - pad * 3, h: gh};
        } else if (!wide && h >= 280) {
            gh = Math.min(gh * 0.45, gw * 0.55);
            rest = {x: pad, y: pad + gh + pad, w: gw, h: h - gh - pad * 3};
        }
        // two gauges side by side
        const cell = gw / 2;
        const r = Math.min(cell, gh - fs * 1.2) / 2 - Math.max(4, gh * 0.06);
        const thick = Math.max(4, r * 0.18);
        gauges.forEach((g, i) => {
            const cx = gx + cell * i + cell / 2;
            const cy = gy + (gh - fs * 1.4) / 2;
            D.gauge(cr, cx, cy, r, thick, g.frac, g.color, t);
            D.text(cr, pct(g.frac), cx, cy - r * 0.1, {size: r * 0.42, weight: D.Weight.MEDIUM, color: t.fg, align: 'center', valign: 'middle', tnum: true, theme: t});
            D.text(cr, g.sub, cx, cy + r * 0.32, {size: Math.max(9, r * 0.2), color: t.dim, align: 'center', valign: 'middle', tnum: true, theme: t});
            D.text(cr, g.label, cx, gy + gh, {size: fs, weight: D.Weight.BOLD, color: t.dim, align: 'center', valign: 'bottom', theme: t});
        });
        if (!rest || rest.w < 60 || rest.h < 50)
            return;

        // CPU history and per-core bars
        let y = rest.y;
        title(cr, 'CPU history', rest.x, y, rest.w, t, fs * 0.85);
        y += fs * 1.4;
        const coresH = s.cores.length && rest.h > 150 ? Math.min(rest.h * 0.35, s.cores.length * 9) : 0;
        const chartH = rest.h - (y - rest.y) - (coresH ? coresH + fs * 2 : fs * 1.6);
        if (chartH > 20) {
            D.setColor(cr, t.faint);
            D.roundRect(cr, rest.x, y, rest.w, chartH, 6);
            cr.fill();
            D.sparkline(cr, rest.x, y + 4, rest.w, chartH - 4, s.cpuHistory, 1, t.accent, 60);
            D.sparkline(cr, rest.x, y + 4, rest.w, chartH - 4, s.memHistory, 1, t.accent2, 60);
            y += chartH + fs * 0.5;
        }
        if (coresH) {
            title(cr, `${s.cores.length} cores`, rest.x, y, rest.w, t, fs * 0.85);
            y += fs * 1.4;
            const cols = s.cores.length > 8 ? 2 : 1;
            const perCol = Math.ceil(s.cores.length / cols);
            const bh = Math.min(6, (coresH - 2) / perCol - 3);
            const colW = (rest.w - (cols - 1) * 10) / cols;
            s.cores.forEach((c, i) => {
                const col = Math.floor(i / perCol), row = i % perCol;
                D.bar(cr, rest.x + col * (colW + 10), y + row * (bh + 3), colW, bh, c, levelColor(c, t) ?? t.accent, t);
            });
        } else {
            const up = s.uptime;
            const d = Math.floor(up / 86400), hh = Math.floor((up % 86400) / 3600), mm = Math.floor((up % 3600) / 60);
            D.text(cr, `Load ${s.load.map(v => v.toFixed(2)).join('  ')}  ·  up ${d ? `${d}d ` : ''}${hh}h ${mm}m`,
                rest.x, rest.y + rest.h, {size: fs * 0.85, color: t.dim, valign: 'bottom', maxWidth: rest.w, tnum: true, theme: t});
        }
    }
}

// --- network ----------------------------------------------------------------

export class NetworkWidget extends Gnomlet {
    static type = 'network';

    enable() {
        subscribe(this, Sys.system());
    }

    draw(cr, w, h, t) {
        const s = this.sample;
        if (!s)
            return;
        const pad = Math.max(12, Math.min(w, h) * 0.08);
        const fs = Math.max(10.5, Math.min(14, Math.min(w, h) * 0.075));
        title(cr, s.iface ? `Network · ${s.iface}` : 'Network', pad, pad, w - pad * 2, t, fs * 0.9);
        const big = Math.max(13, Math.min(h * 0.14, w * 0.08));
        const rowY = pad + fs * 1.6;
        const colW = (w - pad * 3) / 2;
        const items = [
            {label: '↓ Down', v: s.rx, hist: s.rxHistory, color: t.accent, total: s.rxTotal},
            {label: '↑ Up', v: s.tx, hist: s.txHistory, color: t.accent2, total: s.txTotal},
        ];
        items.forEach((it, i) => {
            const x = pad + i * (colW + pad);
            D.text(cr, it.label, x, rowY, {size: fs * 0.85, weight: D.Weight.BOLD, color: it.color, theme: t});
            D.text(cr, D.formatRate(it.v), x, rowY + fs * 1.3, {size: big, weight: D.Weight.MEDIUM, color: t.fg, tnum: true, maxWidth: colW, theme: t});
        });
        const chartY = rowY + fs * 1.3 + big * 1.45;
        const chartH = h - chartY - pad - (h > 220 ? fs * 1.6 : 0);
        if (chartH > 16) {
            const max = Math.max(1024, ...s.rxHistory, ...s.txHistory) * 1.15;
            D.setColor(cr, t.faint);
            D.roundRect(cr, pad, chartY, w - pad * 2, chartH, 6);
            cr.fill();
            D.sparkline(cr, pad, chartY + 4, w - pad * 2, chartH - 4, s.rxHistory, max, t.accent, 60);
            D.sparkline(cr, pad, chartY + 4, w - pad * 2, chartH - 4, s.txHistory, max, t.accent2, 60);
            D.text(cr, D.formatRate(max), w - pad - 4, chartY + 3, {size: fs * 0.7, color: t.dim, align: 'right', theme: t});
        }
        if (h > 220) {
            D.text(cr, `Since boot  ↓ ${D.formatBytes(s.rxTotal)}   ↑ ${D.formatBytes(s.txTotal)}`, pad, h - pad,
                {size: fs * 0.85, color: t.dim, valign: 'bottom', maxWidth: w - pad * 2, theme: t});
        }
    }
}

// --- disks ------------------------------------------------------------------

export class DisksWidget extends Gnomlet {
    static type = 'disks';

    enable() {
        subscribe(this, Sys.disks());
    }

    draw(cr, w, h, t) {
        const disks = this.sample?.disks ?? [];
        const pad = Math.max(12, Math.min(w, h) * 0.08);
        const fs = Math.max(10.5, Math.min(14, Math.min(w, h) * 0.075));
        if (!disks.length) {
            title(cr, 'Disks', pad, pad, w, t, fs * 0.9);
            return;
        }
        const root = disks[0];
        const others = disks.slice(1);
        let y = pad;
        let x = pad;
        let listW = w - pad * 2;
        // a ring for the first filesystem when the widget is roomy
        const ringBox = Math.min(h - pad * 2, w * 0.42);
        if (w > 260 && ringBox > 90) {
            const r = ringBox / 2 - 6;
            const cx = pad + ringBox / 2, cy = h / 2;
            const frac = root.used / root.size;
            D.gauge(cr, cx, cy, r, Math.max(5, r * 0.16), frac, levelColor(frac, t) ?? t.accent, t);
            D.text(cr, pct(frac), cx, cy - r * 0.08, {size: r * 0.38, weight: D.Weight.MEDIUM, color: t.fg, align: 'center', valign: 'middle', tnum: true, theme: t});
            D.text(cr, `${D.formatBytes(root.avail)} free`, cx, cy + r * 0.32, {size: Math.max(9, r * 0.16), color: t.dim, align: 'center', valign: 'middle', tnum: true, theme: t});
            x = pad * 2 + ringBox;
            listW = w - x - pad;
        }
        const list = x === pad ? disks : [root, ...others];
        const rowH = fs * 3.1;
        const maxRows = Math.max(1, Math.floor((h - pad * 2) / rowH));
        const shown = list.slice(0, maxRows);
        y = x === pad ? pad : Math.max(pad, (h - shown.length * rowH) / 2);
        for (const d of shown) {
            const frac = d.used / d.size;
            const name = d.target === '/' ? 'System' : d.target.split('/').pop() || d.target;
            D.text(cr, name, x, y, {size: fs, weight: D.Weight.MEDIUM, color: t.fg, maxWidth: listW * 0.55, theme: t});
            D.text(cr, `${D.formatBytes(d.used, 0)} / ${D.formatBytes(d.size, 0)}`, x + listW, y + fs * 0.1,
                {size: fs * 0.82, color: t.dim, align: 'right', tnum: true, theme: t});
            D.bar(cr, x, y + fs * 1.55, listW, Math.max(5, fs * 0.45), frac, levelColor(frac, t) ?? t.accent, t);
            y += rowH;
        }
    }
}

// --- processes --------------------------------------------------------------

export class ProcessesWidget extends Gnomlet {
    static type = 'processes';
    static defaults = {sort: 'cpu'};

    enable() {
        subscribe(this, Sys.processes());
    }

    buildMenu(m) {
        m.radio('Sort by CPU', this.opts.sort === 'cpu', () => this.setOpt('sort', 'cpu'));
        m.radio('Sort by memory', this.opts.sort === 'mem', () => this.setOpt('sort', 'mem'));
        m.action('Open System Monitor', () => {
            try {
                GLib.spawn_command_line_async('gnome-system-monitor -p');
            } catch {}
        });
    }

    draw(cr, w, h, t) {
        const s = this.sample;
        const pad = Math.max(12, Math.min(w, h) * 0.08);
        const fs = Math.max(10.5, Math.min(13.5, Math.min(w, h) * 0.07));
        title(cr, this.opts.sort === 'mem' ? 'Top memory' : 'Top processes', pad, pad, w - pad * 2, t, fs * 0.9);
        if (!s)
            return;
        const list = [...s.list];
        if (this.opts.sort === 'mem')
            list.sort((a, b) => b.rss - a.rss);
        const rowH = fs * 1.85;
        const y0 = pad + fs * 1.8;
        const rows = Math.max(0, Math.floor((h - y0 - pad + fs * 0.4) / rowH));
        const memW = fs * 4.6, cpuW = fs * 3.6;
        const nameW = w - pad * 2 - memW - cpuW;
        const maxCpu = Math.max(1, ...list.slice(0, rows).map(p => p.cpu));
        list.slice(0, rows).forEach((p, i) => {
            const y = y0 + i * rowH;
            const barFrac = this.opts.sort === 'mem' ? p.rss / list[0].rss : p.cpu / maxCpu;
            const bw = (w - pad * 2 + 8) * barFrac;
            if (bw > 12) {
                D.setColor(cr, this.opts.sort === 'mem' ? t.accent2 : t.accent, 0.16);
                D.roundRect(cr, pad - 4, y - 2, bw, rowH - 3, 5);
                cr.fill();
            }
            D.text(cr, p.name, pad, y + rowH / 2 - 2, {size: fs, color: t.fg, valign: 'middle', maxWidth: nameW - 6, theme: t});
            D.text(cr, `${(p.cpu * 100).toFixed(p.cpu >= 0.1 ? 0 : 1)}%`, pad + nameW + cpuW, y + rowH / 2 - 2,
                {size: fs, weight: D.Weight.MEDIUM, color: t.fg, align: 'right', valign: 'middle', tnum: true, theme: t});
            D.text(cr, D.formatBytes(p.rss, 0), w - pad, y + rowH / 2 - 2,
                {size: fs * 0.9, color: t.dim, align: 'right', valign: 'middle', tnum: true, theme: t});
        });
    }
}

// --- battery ----------------------------------------------------------------

export class BatteryWidget extends Gnomlet {
    static type = 'battery';

    enable() {
        subscribe(this, Sys.battery());
    }

    draw(cr, w, h, t) {
        const s = this.sample;
        const pad = Math.max(12, Math.min(w, h) * 0.08);
        const fs = Math.max(10.5, Math.min(14, Math.min(w, h) * 0.075));
        const bats = s?.batteries ?? [];
        if (!bats.length) {
            title(cr, 'Battery', pad, pad, w, t, fs * 0.9);
            D.text(cr, s?.ac ? 'On AC power, no battery' : 'No battery found', w / 2, h / 2,
                {size: fs, color: t.dim, align: 'center', valign: 'middle', maxWidth: w - pad * 2, theme: t});
            return;
        }
        const n = bats.length;
        const cell = (w - pad * 2) / n;
        bats.forEach((b, i) => {
            const frac = b.capacity / 100;
            const charging = b.status === 'Charging' || b.status === 'Full' || (b.status === 'Not charging' && s.ac);
            const color = charging ? t.good : frac < 0.15 ? t.crit : frac < 0.3 ? t.warn : t.good;
            const cx = pad + cell * i + cell / 2;
            const r = Math.min(cell, h - pad * 2 - fs * 2.8) / 2 - 4;
            const cy = pad + r + 4;
            D.gauge(cr, cx, cy, r, Math.max(5, r * 0.15), frac, color, t);
            D.text(cr, `${Math.round(b.capacity)}%`, cx, cy, {size: r * 0.42, weight: D.Weight.MEDIUM, color: t.fg, align: 'center', valign: 'middle', tnum: true, theme: t});
            if (charging) {
                // a small bolt above the number
                const bs = r * 0.22, by = cy - r * 0.48;
                D.setColor(cr, t.good);
                cr.moveTo(cx + bs * 0.15, by - bs * 0.5);
                cr.lineTo(cx - bs * 0.35, by + bs * 0.1);
                cr.lineTo(cx, by + bs * 0.1);
                cr.lineTo(cx - bs * 0.15, by + bs * 0.5);
                cr.lineTo(cx + bs * 0.35, by - bs * 0.1);
                cr.lineTo(cx, by - bs * 0.1);
                cr.closePath();
                cr.fill();
            }
            let status = b.status === 'Discharging' ? 'On battery'
                : b.status === 'Charging' ? 'Charging'
                    : b.status === 'Full' ? 'Fully charged'
                        : b.status === 'Not charging' ? 'Not charging' : b.status;
            let detail = '';
            if (b.hours !== null && b.hours > 0 && b.hours < 48) {
                const hh = Math.floor(b.hours), mm = Math.round((b.hours - hh) * 60);
                detail = `${hh}:${String(mm).padStart(2, '0')} ${b.status === 'Charging' ? 'to full' : 'left'}`;
            }
            D.text(cr, status, cx, h - pad - (detail ? fs * 1.3 : 0), {size: fs, weight: D.Weight.MEDIUM, color: t.fg, align: 'center', valign: 'bottom', maxWidth: cell - 8, theme: t});
            if (detail)
                D.text(cr, detail, cx, h - pad, {size: fs * 0.85, color: t.dim, align: 'center', valign: 'bottom', tnum: true, maxWidth: cell - 8, theme: t});
        });
    }
}
