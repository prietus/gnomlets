// Themes: colors are [r, g, b, a] in 0..1. Shared by the shell and the prefs window.

const hex = (h, a = 1) => {
    const n = parseInt(h.replace('#', ''), 16);
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255, a];
};

export const THEMES = {
    dark: {
        name: 'Dark',
        bg: hex('#1e1e22', 0.92),
        border: hex('#ffffff', 0.08),
        fg: hex('#f5f5f7'),
        dim: hex('#a1a1aa'),
        faint: hex('#ffffff', 0.10),
        accent: hex('#0a84ff'),
        accent2: hex('#bf5af2'),
        good: hex('#30d158'),
        warn: hex('#ffd60a'),
        crit: hex('#ff453a'),
        radius: 22,
        gauge: 'ring',
        font: null,
    },
    light: {
        name: 'Light',
        bg: hex('#ffffff', 0.90),
        border: hex('#000000', 0.08),
        fg: hex('#1d1d1f'),
        dim: hex('#6e6e73'),
        faint: hex('#000000', 0.08),
        accent: hex('#007aff'),
        accent2: hex('#af52de'),
        good: hex('#28a745'),
        warn: hex('#f5a300'),
        crit: hex('#ff3b30'),
        radius: 22,
        gauge: 'ring',
        font: null,
    },
    glass: {
        name: 'Glass',
        bg: hex('#141418', 0.45),
        border: hex('#ffffff', 0.18),
        fg: hex('#ffffff'),
        dim: hex('#ffffff', 0.68),
        faint: hex('#ffffff', 0.16),
        accent: hex('#64d2ff'),
        accent2: hex('#ff9ff3'),
        good: hex('#7cf29c'),
        warn: hex('#ffe066'),
        crit: hex('#ff7a70'),
        radius: 28,
        gauge: 'arc',
        font: null,
    },
    mocha: {
        name: 'Catppuccin Mocha',
        bg: hex('#1e1e2e', 0.94),
        border: hex('#313244'),
        fg: hex('#cdd6f4'),
        dim: hex('#a6adc8'),
        faint: hex('#313244'),
        accent: hex('#89b4fa'),
        accent2: hex('#cba6f7'),
        good: hex('#a6e3a1'),
        warn: hex('#f9e2af'),
        crit: hex('#f38ba8'),
        radius: 18,
        gauge: 'ring',
        font: null,
    },
    nord: {
        name: 'Nord',
        bg: hex('#2e3440', 0.95),
        border: hex('#3b4252'),
        fg: hex('#eceff4'),
        dim: hex('#d8dee9', 0.7),
        faint: hex('#3b4252'),
        accent: hex('#88c0d0'),
        accent2: hex('#b48ead'),
        good: hex('#a3be8c'),
        warn: hex('#ebcb8b'),
        crit: hex('#bf616a'),
        radius: 10,
        gauge: 'arc',
        font: null,
    },
    gruvbox: {
        name: 'Gruvbox',
        bg: hex('#282828', 0.96),
        border: hex('#3c3836'),
        fg: hex('#ebdbb2'),
        dim: hex('#a89984'),
        faint: hex('#3c3836'),
        accent: hex('#83a598'),
        accent2: hex('#d3869b'),
        good: hex('#b8bb26'),
        warn: hex('#fabd2f'),
        crit: hex('#fb4934'),
        radius: 4,
        gauge: 'arc',
        font: 'Monospace',
    },
};

export const THEME_IDS = ['auto', ...Object.keys(THEMES)];

export function themeLabel(id) {
    return id === 'auto' ? 'Automatic (follows system style)' : THEMES[id]?.name ?? id;
}

/**
 * @param {string} id theme id or 'auto'
 * @param {boolean} prefersDark system color scheme
 * @param {number} opacity 0..1 multiplier for the card background
 */
export function resolveTheme(id, prefersDark, opacity = 1) {
    let base = THEMES[id];
    if (!base)
        base = prefersDark ? THEMES.dark : THEMES.light;
    const t = {...base};
    t.bg = [...base.bg];
    t.bg[3] *= opacity;
    t.id = THEMES[id] ? id : prefersDark ? 'dark' : 'light';
    return t;
}

export function cssColor(c) {
    return `rgba(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)},${c[3].toFixed(3)})`;
}
