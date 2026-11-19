// Shared cairo / pango drawing primitives.
import Pango from 'gi://Pango';
import PangoCairo from 'gi://PangoCairo';

/** The family of a GNOME font setting such as "Adwaita Sans 11". */
export function fontFamily(fontName) {
    try {
        return Pango.FontDescription.from_string(fontName).get_family() || 'Sans';
    } catch {
        return 'Sans';
    }
}

export function setColor(cr, c, alpha = 1) {
    cr.setSourceRGBA(c[0], c[1], c[2], c[3] * alpha);
}

export function mix(a, b, t) {
    return [0, 1, 2, 3].map(i => a[i] + (b[i] - a[i]) * t);
}

export function withAlpha(c, a) {
    return [c[0], c[1], c[2], a];
}

export function roundRect(cr, x, y, w, h, r) {
    r = Math.max(0, Math.min(r, w / 2, h / 2));
    cr.newSubPath();
    cr.arc(x + w - r, y + r, r, -Math.PI / 2, 0);
    cr.arc(x + w - r, y + h - r, r, 0, Math.PI / 2);
    cr.arc(x + r, y + h - r, r, Math.PI / 2, Math.PI);
    cr.arc(x + r, y + r, r, Math.PI, 1.5 * Math.PI);
    cr.closePath();
}

function _layout(cr, str, o) {
    const layout = PangoCairo.create_layout(cr);
    const family = o.font ?? o.theme?.font ?? o.theme?.uiFont ?? 'Sans';
    const desc = Pango.FontDescription.from_string(family);
    desc.set_weight(o.weight ?? Pango.Weight.NORMAL);
    desc.set_absolute_size(Math.max(1, o.size ?? 13) * Pango.SCALE);
    layout.set_font_description(desc);
    if (o.tnum) {
        const attrs = new Pango.AttrList();
        attrs.insert(Pango.attr_font_features_new('tnum'));
        layout.set_attributes(attrs);
    }
    if (o.maxWidth) {
        layout.set_width(Math.max(1, o.maxWidth) * Pango.SCALE);
        if (o.wrap) {
            layout.set_wrap(Pango.WrapMode.WORD_CHAR);
            if (o.maxHeight) {
                layout.set_height(-Math.max(1, Math.floor(o.maxHeight / ((o.size ?? 13) * 1.2))));
                layout.set_ellipsize(Pango.EllipsizeMode.END);
            }
        } else {
            layout.set_ellipsize(Pango.EllipsizeMode.END);
        }
    }
    if (o.align === 'center')
        layout.set_alignment(Pango.Alignment.CENTER);
    else if (o.align === 'right')
        layout.set_alignment(Pango.Alignment.RIGHT);
    layout.set_text(String(str), -1);
    return layout;
}

export function measure(cr, str, o = {}) {
    const layout = _layout(cr, str, o);
    const [, logical] = layout.get_pixel_extents();
    return {width: logical.width, height: logical.height};
}

/**
 * Draws text. x is the left edge, the center or the right edge depending on
 * align; y is the top, the middle or the baseline depending on valign.
 */
export function text(cr, str, x, y, o = {}) {
    const layout = _layout(cr, str, o);
    const [, logical] = layout.get_pixel_extents();
    const w = o.maxWidth ? Math.min(logical.width, o.maxWidth) : logical.width;
    let dx = x;
    if (!o.maxWidth) {
        if (o.align === 'center')
            dx = x - w / 2;
        else if (o.align === 'right')
            dx = x - w;
    } else if (o.align === 'center') {
        dx = x - o.maxWidth / 2;
    } else if (o.align === 'right') {
        dx = x - o.maxWidth;
    }
    let dy = y;
    if (o.valign === 'middle')
        dy = y - logical.height / 2;
    else if (o.valign === 'bottom')
        dy = y - logical.height;
    else if (o.valign === 'baseline')
        dy = y - layout.get_baseline() / Pango.SCALE;
    setColor(cr, o.color ?? [1, 1, 1, 1]);
    cr.moveTo(dx, dy);
    PangoCairo.show_layout(cr, layout);
    return {width: w, height: logical.height};
}

/** A ring (or a 270° arc, depending on the theme) filled to frac. */
export function gauge(cr, cx, cy, r, thick, frac, color, theme) {
    frac = Math.max(0, Math.min(1, frac || 0));
    const arc = theme.gauge === 'arc';
    const a0 = arc ? 0.75 * Math.PI : -Math.PI / 2;
    const span = arc ? 1.5 * Math.PI : 2 * Math.PI;
    cr.setLineWidth(thick);
    cr.setLineCap(1 /* ROUND */);
    setColor(cr, theme.faint);
    cr.newPath();
    cr.arc(cx, cy, r, a0, a0 + span);
    cr.stroke();
    if (frac > 0.002) {
        setColor(cr, color);
        cr.newPath();
        cr.arc(cx, cy, r, a0, a0 + span * frac);
        cr.stroke();
    }
}

export function bar(cr, x, y, w, h, frac, color, theme) {
    frac = Math.max(0, Math.min(1, frac || 0));
    setColor(cr, theme.faint);
    roundRect(cr, x, y, w, h, h / 2);
    cr.fill();
    if (frac > 0) {
        setColor(cr, color);
        roundRect(cr, x, y, Math.max(h, w * frac), h, h / 2);
        cr.fill();
    }
}

/** A filled line chart of values scaled to max, newest on the right. */
export function sparkline(cr, x, y, w, h, values, max, color, capacity) {
    const n = capacity ?? values.length;
    if (values.length < 2 || max <= 0)
        return;
    const step = w / Math.max(1, n - 1);
    const x0 = x + w - (values.length - 1) * step;
    const py = v => y + h - Math.min(1, v / max) * h;
    cr.newPath();
    cr.moveTo(x0, py(values[0]));
    for (let i = 1; i < values.length; i++)
        cr.lineTo(x0 + i * step, py(values[i]));
    cr.setLineWidth(1.6);
    cr.setLineJoin(1);
    setColor(cr, color);
    cr.strokePreserve();
    cr.lineTo(x0 + (values.length - 1) * step, y + h);
    cr.lineTo(x0, y + h);
    cr.closePath();
    setColor(cr, color, 0.18);
    cr.fill();
}

export function circle(cr, cx, cy, r, color) {
    cr.newPath();
    cr.arc(cx, cy, r, 0, 2 * Math.PI);
    setColor(cr, color);
    cr.fill();
}

// --- media control glyphs -------------------------------------------------

export function playGlyph(cr, cx, cy, s, color) {
    cr.newPath();
    cr.moveTo(cx - s * 0.35, cy - s * 0.5);
    cr.lineTo(cx + s * 0.5, cy);
    cr.lineTo(cx - s * 0.35, cy + s * 0.5);
    cr.closePath();
    setColor(cr, color);
    cr.fill();
}

export function pauseGlyph(cr, cx, cy, s, color) {
    setColor(cr, color);
    roundRect(cr, cx - s * 0.4, cy - s * 0.5, s * 0.28, s, s * 0.06);
    cr.fill();
    roundRect(cr, cx + s * 0.12, cy - s * 0.5, s * 0.28, s, s * 0.06);
    cr.fill();
}

export function skipGlyph(cr, cx, cy, s, color, forward) {
    const d = forward ? 1 : -1;
    setColor(cr, color);
    for (const off of [-0.45, 0.05]) {
        cr.newPath();
        cr.moveTo(cx + d * (off * s), cy - s * 0.4);
        cr.lineTo(cx + d * ((off + 0.45) * s), cy);
        cr.lineTo(cx + d * (off * s), cy + s * 0.4);
        cr.closePath();
        cr.fill();
    }
}

// --- weather glyphs -------------------------------------------------------

function sun(cr, cx, cy, r, color) {
    circle(cr, cx, cy, r * 0.55, color);
    cr.setLineWidth(Math.max(1, r * 0.14));
    cr.setLineCap(1);
    setColor(cr, color);
    for (let i = 0; i < 8; i++) {
        const a = (i * Math.PI) / 4;
        cr.newPath();
        cr.moveTo(cx + Math.cos(a) * r * 0.75, cy + Math.sin(a) * r * 0.75);
        cr.lineTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
        cr.stroke();
    }
}

function moon(cr, cx, cy, r, color) {
    cr.pushGroup();
    circle(cr, cx, cy, r * 0.7, color);
    cr.setOperator(0 /* CLEAR */);
    circle(cr, cx + r * 0.38, cy - r * 0.3, r * 0.58, [0, 0, 0, 1]);
    cr.setOperator(2 /* OVER */);
    cr.popGroupToSource();
    cr.paint();
}

function cloud(cr, cx, cy, s, color) {
    setColor(cr, color);
    cr.newPath();
    cr.arc(cx - s * 0.28, cy + s * 0.05, s * 0.24, 0, 2 * Math.PI);
    cr.fill();
    cr.arc(cx + 0.02 * s, cy - s * 0.1, s * 0.32, 0, 2 * Math.PI);
    cr.fill();
    cr.arc(cx + s * 0.3, cy + s * 0.06, s * 0.22, 0, 2 * Math.PI);
    cr.fill();
    roundRect(cr, cx - s * 0.52, cy + s * 0.02, s * 1.04, s * 0.27, s * 0.13);
    cr.fill();
}

/** WMO weather code → glyph, drawn in a box of side `size` centered on cx, cy. */
export function weatherGlyph(cr, code, isDay, cx, cy, size, theme) {
    const sunC = [1.0, 0.8, 0.2, 1];
    const light = theme.id === 'light';
    const moonC = light ? [0.55, 0.6, 0.72, 1] : [0.93, 0.93, 0.85, 1];
    const cloudC = light ? [0.62, 0.66, 0.72, 1] : [0.88, 0.9, 0.94, 1];
    const darkCloud = light ? [0.45, 0.48, 0.55, 1] : [0.66, 0.69, 0.75, 1];
    const rainC = [0.35, 0.65, 1.0, 1];
    const s = size;
    const celestial = (x, y, r) => (isDay ? sun(cr, x, y, r, sunC) : moon(cr, x, y, r, moonC));

    if (code === 0) {
        celestial(cx, cy, s * 0.42);
        return;
    }
    if (code === 1 || code === 2) {
        celestial(cx - s * 0.16, cy - s * 0.16, s * 0.3);
        cloud(cr, cx + s * 0.06, cy + s * 0.12, s * 0.7, cloudC);
        return;
    }
    if (code === 45 || code === 48) {
        cloud(cr, cx, cy - s * 0.12, s * 0.75, cloudC);
        cr.setLineWidth(Math.max(1, s * 0.06));
        cr.setLineCap(1);
        setColor(cr, darkCloud);
        for (const [dy, w] of [[0.22, 0.7], [0.36, 0.5]]) {
            cr.newPath();
            cr.moveTo(cx - (s * w) / 2, cy + s * dy);
            cr.lineTo(cx + (s * w) / 2, cy + s * dy);
            cr.stroke();
        }
        return;
    }
    const heavy = code >= 95 || [3, 63, 65, 67, 82, 75, 86].includes(code);
    cloud(cr, cx, cy - s * 0.12, s * 0.8, heavy ? darkCloud : cloudC);
    if (code === 3)
        return;

    const snow = (code >= 71 && code <= 77) || code === 85 || code === 86;
    const storm = code >= 95;
    const drops = [-0.22, 0, 0.22];
    if (snow) {
        for (const dx of drops) {
            const snowC = light ? [0.5, 0.7, 0.95, 1] : [0.95, 0.97, 1, 1];
            circle(cr, cx + s * dx, cy + s * 0.3, s * 0.05, snowC);
            circle(cr, cx + s * dx + s * 0.08, cy + s * 0.42, s * 0.04, snowC);
        }
    } else {
        cr.setLineWidth(Math.max(1, s * 0.055));
        cr.setLineCap(1);
        setColor(cr, rainC);
        for (const dx of storm ? [-0.25, 0.25] : drops) {
            cr.newPath();
            cr.moveTo(cx + s * dx + s * 0.05, cy + s * 0.24);
            cr.lineTo(cx + s * dx - s * 0.04, cy + s * 0.42);
            cr.stroke();
        }
    }
    if (storm) {
        setColor(cr, sunC);
        cr.newPath();
        cr.moveTo(cx + s * 0.04, cy + s * 0.12);
        cr.lineTo(cx - s * 0.1, cy + s * 0.32);
        cr.lineTo(cx, cy + s * 0.32);
        cr.lineTo(cx - s * 0.06, cy + s * 0.5);
        cr.lineTo(cx + s * 0.12, cy + s * 0.26);
        cr.lineTo(cx + s * 0.02, cy + s * 0.26);
        cr.closePath();
        cr.fill();
    }
}

export const WEATHER_TEXT = {
    0: 'Clear', 1: 'Mostly Clear', 2: 'Partly Cloudy', 3: 'Cloudy',
    45: 'Fog', 48: 'Freezing Fog',
    51: 'Light Drizzle', 53: 'Drizzle', 55: 'Heavy Drizzle',
    56: 'Freezing Drizzle', 57: 'Freezing Drizzle',
    61: 'Light Rain', 63: 'Rain', 65: 'Heavy Rain',
    66: 'Freezing Rain', 67: 'Freezing Rain',
    71: 'Light Snow', 73: 'Snow', 75: 'Heavy Snow', 77: 'Snow Grains',
    80: 'Showers', 81: 'Showers', 82: 'Heavy Showers',
    85: 'Snow Showers', 86: 'Snow Showers',
    95: 'Thunderstorm', 96: 'Thunderstorm with Hail', 99: 'Thunderstorm with Hail',
};

export function formatBytes(n, digits = 1) {
    const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
    let i = 0;
    while (Math.abs(n) >= 1024 && i < units.length - 1) {
        n /= 1024;
        i++;
    }
    return `${n.toFixed(i === 0 ? 0 : n >= 100 ? 0 : digits)} ${units[i]}`;
}

export function formatRate(bytesPerSec) {
    return `${formatBytes(bytesPerSec)}/s`;
}

export const Weight = Pango.Weight;
