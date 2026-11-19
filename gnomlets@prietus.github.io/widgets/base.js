import GLib from 'gi://GLib';

/**
 * Base class of every widget. A widget draws itself with cairo in draw() and
 * may add actors of its own (cover art...) to host.overlay, placed in layout().
 *
 * The host is the frame: host.repaint(), host.saveOpts(), host.overlay,
 * host.menuItem()...
 */
export class Gnomlet {
    static type = '';
    static title = '';
    static description = '';
    static icon = 'application-x-addon-symbolic';
    // macOS-like presets; `size` is the one a new widget gets.
    static sizes = {small: [170, 170], medium: [360, 170], large: [360, 380]};
    static size = 'medium';
    static minSize = [120, 100];
    static defaults = {};

    constructor(host, opts) {
        this.host = host;
        this.opts = {...this.constructor.defaults, ...(opts ?? {})};
        this._sources = new Set();
        this._cleanups = [];
    }

    // --- lifecycle, called by the frame ---
    enable() {}

    disable() {
        for (const id of this._sources)
            GLib.source_remove(id);
        this._sources.clear();
        for (const fn of this._cleanups.splice(0))
            fn();
    }

    // --- drawing ---
    draw(_cr, _w, _h, _theme) {}

    layout(_w, _h, _theme) {}

    // --- input; coordinates are local to the widget ---
    /** @returns {boolean} true if the click was used */
    click(_x, _y, _w, _h) {
        return false;
    }

    scroll(_direction) {
        return false;
    }

    /** Adds widget-specific entries to the context menu. */
    buildMenu(_m) {}

    /** Called when options change from outside (the prefs window). */
    optsChanged() {}

    // --- helpers ---
    setOpt(key, value) {
        this.opts[key] = value;
        this.host.saveOpts(this.opts);
        this.optsChanged();
        this.host.repaint();
    }

    every(ms, fn) {
        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            fn();
            return GLib.SOURCE_CONTINUE;
        });
        this._sources.add(id);
        return id;
    }

    /** Calls fn at every multiple of periodMs of the wall clock (each second, each minute). */
    aligned(periodMs, fn) {
        const schedule = () => {
            const now = Date.now();
            const delay = periodMs - (now % periodMs) + 5;
            const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
                this._sources.delete(id);
                fn();
                schedule();
                return GLib.SOURCE_REMOVE;
            });
            this._sources.add(id);
        };
        schedule();
    }

    cancel(id) {
        if (this._sources.delete(id))
            GLib.source_remove(id);
    }

    onDisable(fn) {
        this._cleanups.push(fn);
    }

    /** Height-based scale so text grows with the widget. */
    unit(w, h) {
        const [bw, bh] = this.constructor.sizes.small;
        return Math.max(0.6, Math.min(3, Math.min(w / bw, h / bh)));
    }
}
