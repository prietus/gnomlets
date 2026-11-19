// Gnomlets: macOS-style desktop widgets for GNOME Shell.
//
// The widgets live in a layer inside Main.layoutManager._backgroundGroup, so
// they sit above the wallpaper and below every window, like desktop icons.
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Extension, InjectionManager} from 'resource:///org/gnome/shell/extensions/extension.js';

import {GnomletFrame} from './lib/frame.js';
import {resolveTheme} from './lib/themes.js';
import {fontFamily} from './lib/draw.js';
import * as Sys from './lib/sysinfo.js';
import {destroySession} from './lib/http.js';
import {WIDGETS, BY_TYPE} from './widgets/index.js';

const SNAP_DISTANCE = 12;

function overlaps(a, b, gap = 0) {
    return a.x < b.x + b.w + gap && b.x < a.x + a.w + gap &&
        a.y < b.y + b.h + gap && b.y < a.y + a.h + gap;
}

function newId() {
    return `w${GLib.uuid_string_random().slice(0, 8)}`;
}

/** Wraps a PopupMenu so widgets can add entries without knowing the shell API. */
function menuBuilder(menu) {
    return {
        action(label, cb) {
            menu.addAction(label, () => cb());
        },
        toggle(label, value, cb) {
            const item = new PopupMenu.PopupSwitchMenuItem(label, !!value);
            item.connect('toggled', (_i, v) => cb(v));
            menu.addMenuItem(item);
        },
        radio(label, checked, cb) {
            const item = new PopupMenu.PopupMenuItem(label);
            item.setOrnament(checked ? PopupMenu.Ornament.CHECK : PopupMenu.Ornament.NONE);
            item.connect('activate', () => cb());
            menu.addMenuItem(item);
        },
        separator() {
            menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        },
        submenu(label, fn) {
            const sub = new PopupMenu.PopupSubMenuMenuItem(label);
            menu.addMenuItem(sub);
            fn(menuBuilder(sub.menu));
        },
    };
}

class Manager {
    constructor(ext) {
        this.ext = ext;
        this.settings = ext.getSettings();
        this._iface = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
        this.frames = new Map(); // id → frame, in stacking order
        this._lastJson = null;

        this.layer = new Clutter.Actor({name: 'gnomlets-layer'});
        const bg = Main.layoutManager._backgroundGroup;
        bg.add_child(this.layer);
        // backgrounds are re-created on monitor changes; keep the layer on top of them
        bg.connectObject('child-added', () => bg.set_child_above_sibling(this.layer, null), this);

        this._updateTheme();
        this._buildMenu();

        this.settings.connectObject(
            'changed::widgets', () => this._sync(),
            'changed::theme', () => this._updateTheme(),
            'changed::opacity', () => this._updateTheme(),
            'changed::locked', () => this.frames.forEach(f => f._updateGrip()),
            this);
        this._iface.connectObject(
            'changed::color-scheme', () => this._updateTheme(),
            'changed::font-name', () => this._updateTheme(),
            'changed::clock-format', () => this.frames.forEach(f => f.repaint()),
            this);
        Main.layoutManager.connectObject('monitors-changed', () => this._clampAll(), this);

        // the work area (panel struts) is only right once the shell has started
        if (Main.layoutManager._startingUp)
            Main.layoutManager.connectObject('startup-complete', () => this._sync(), this);
        else
            this._sync();
        this._setupBackgroundMenus();
    }

    destroy() {
        this._teardownBackgroundMenus();
        this.settings.disconnectObject(this);
        this._iface.disconnectObject(this);
        this._iface = null;
        Main.layoutManager.disconnectObject(this);
        Main.layoutManager._backgroundGroup.disconnectObject(this);
        this._menu?.destroy();
        this._menu = null;
        for (const f of this.frames.values())
            f.destroy();
        this.frames.clear();
        this.layer.destroy();
    }

    /** The system clock format, shared by every widget that shows a time. */
    get use24h() {
        return this._iface.get_string('clock-format') !== '12h';
    }

    get locked() {
        return this.settings.get_boolean('locked');
    }

    // --- model ------------------------------------------------------------

    _load() {
        let list = [];
        try {
            list = JSON.parse(this.settings.get_string('widgets'));
        } catch (e) {
            console.warn(`gnomlets: bad widgets setting: ${e.message}`);
        }
        if (!Array.isArray(list))
            list = [];
        const seen = new Set();
        return list.filter(m => m && BY_TYPE[m.type]).map(m => {
            const W = BY_TYPE[m.type];
            const [dw, dh] = W.sizes[W.size];
            let id = typeof m.id === 'string' && m.id ? m.id : newId();
            if (seen.has(id))
                id = newId();
            seen.add(id);
            return {
                id,
                type: m.type,
                x: Number.isFinite(m.x) ? m.x : -1,
                y: Number.isFinite(m.y) ? m.y : -1,
                w: Math.max(W.minSize[0], Number.isFinite(m.w) && m.w > 0 ? m.w : dw),
                h: Math.max(W.minSize[1], Number.isFinite(m.h) && m.h > 0 ? m.h : dh),
                opts: m.opts && typeof m.opts === 'object' ? m.opts : {},
            };
        });
    }

    save() {
        const list = [...this.frames.values()].map(f => f.model);
        const json = JSON.stringify(list);
        if (json === this._lastJson)
            return;
        this._lastJson = json;
        this.settings.set_string('widgets', json);
    }

    _sync() {
        const json = this.settings.get_string('widgets');
        if (json === this._lastJson)
            return;
        const models = this._load();
        const ids = new Set(models.map(m => m.id));
        for (const [id, f] of this.frames) {
            if (!ids.has(id) || f.model.type !== models.find(m => m.id === id).type) {
                f.destroy();
                this.frames.delete(id);
            }
        }
        let dirty = false;
        const ordered = new Map();
        for (const m of models) {
            if (m.x < 0 || m.y < 0) {
                Object.assign(m, this._freeSpot(m.w, m.h, [...ordered.values()].map(f => f.model)));
                dirty = true;
            }
            let f = this.frames.get(m.id);
            if (f) {
                f.setModel(m);
            } else {
                f = new GnomletFrame(this, m, BY_TYPE[m.type]);
                this.layer.add_child(f);
            }
            this.layer.set_child_above_sibling(f, null);
            ordered.set(m.id, f);
        }
        this.frames = ordered;
        this._lastJson = json;
        this._clampAll();
        if (dirty)
            this.save();
    }

    // --- adding, removing, stacking -----------------------------------------

    addWidget(type, at = null) {
        const W = BY_TYPE[type];
        const [w, h] = W.sizes[W.size];
        let pos;
        if (at) {
            pos = this._clampRect({x: at[0] - w / 2, y: at[1] - 20, w, h});
            pos = this.snapMove(null, pos);
        } else {
            pos = this._freeSpot(w, h, [...this.frames.values()].map(f => f.model));
        }
        const model = {id: newId(), type, x: Math.round(pos.x), y: Math.round(pos.y), w, h, opts: {}};
        const f = new GnomletFrame(this, model, W);
        this.layer.add_child(f);
        this.frames.set(model.id, f);
        f.opacity = 0;
        f.set_pivot_point(0.5, 0.5);
        f.scale_x = f.scale_y = 0.8;
        f.ease({opacity: 255, scale_x: 1, scale_y: 1, duration: 220, mode: Clutter.AnimationMode.EASE_OUT_BACK});
        this.save();
        return f;
    }

    duplicate(frame) {
        const m = frame.model;
        const model = {...m, id: newId(), opts: structuredClone(m.opts ?? {})};
        const pos = this._freeSpot(m.w, m.h, [...this.frames.values()].map(f => f.model), {x: m.x + m.w, y: m.y});
        Object.assign(model, {x: pos.x, y: pos.y});
        const f = new GnomletFrame(this, model, frame.WidgetClass);
        this.layer.add_child(f);
        this.frames.set(model.id, f);
        this.save();
    }

    remove(frame) {
        this.frames.delete(frame.model.id);
        frame.reactive = false;
        frame.set_pivot_point(0.5, 0.5);
        frame.ease({
            opacity: 0, scale_x: 0.8, scale_y: 0.8, duration: 180,
            onStopped: () => frame.destroy(),
        });
        this.save();
    }

    raise(frame) {
        this.layer.set_child_above_sibling(frame, null);
        const id = frame.model.id;
        this.frames.delete(id);
        this.frames.set(id, frame);
    }

    resizeTo(frame, preset) {
        const [w, h] = frame.WidgetClass.sizes[preset];
        const r = this._clampRect({x: frame.x, y: frame.y, w, h});
        frame.setGeometry(r.x, r.y, w, h);
        Object.assign(frame.model, {x: Math.round(r.x), y: Math.round(r.y), w, h});
        this.save();
    }

    openPrefs(focusId = '') {
        this.settings.set_string('prefs-focus', focusId);
        try {
            this.ext.openPreferences();
        } catch (e) {
            console.error(`gnomlets: ${e.message}`);
        }
    }

    // --- theme ---------------------------------------------------------------

    _updateTheme() {
        const dark = this._iface.get_string('color-scheme') === 'prefer-dark';
        this.theme = resolveTheme(this.settings.get_string('theme'), dark,
            this.settings.get_int('opacity') / 100);
        this.theme.uiFont = fontFamily(this._iface.get_string('font-name'));
        for (const f of this.frames.values())
            f.setTheme(this.theme);
    }

    // --- geometry: work areas, free spots, snapping --------------------------

    _workAreaFor(rect) {
        const lm = Main.layoutManager;
        const cx = rect.x + rect.w / 2, cy = rect.y + rect.h / 2;
        let idx = lm.primaryIndex;
        lm.monitors.forEach((m, i) => {
            if (cx >= m.x && cx < m.x + m.width && cy >= m.y && cy < m.y + m.height)
                idx = i;
        });
        const wa = lm.getWorkAreaForMonitor(idx);
        return {x: wa.x, y: wa.y, w: wa.width, h: wa.height};
    }

    _clampRect(r) {
        const wa = this._workAreaFor(r);
        return {
            ...r,
            x: Math.max(wa.x, Math.min(r.x, wa.x + wa.w - Math.min(r.w, wa.w))),
            y: Math.max(wa.y, Math.min(r.y, wa.y + wa.h - Math.min(r.h, wa.h))),
        };
    }

    _clampAll() {
        // keep every widget reachable after a monitor goes away; does not save
        for (const f of this.frames.values()) {
            const r = this._clampRect({x: f.model.x, y: f.model.y, w: f.model.w, h: f.model.h});
            f.set_position(Math.round(r.x), Math.round(r.y));
        }
    }

    /** Finds a place for a w×h widget next to the others, top-left first. */
    _freeSpot(w, h, others, near = null) {
        const lm = Main.layoutManager;
        const wa0 = lm.getWorkAreaForMonitor(lm.primaryIndex);
        const wa = {x: wa0.x, y: wa0.y, w: wa0.width, h: wa0.height};
        const g = this.settings.get_int('gap');
        const m = Math.max(g, 24);
        const cands = [{x: wa.x + m, y: wa.y + m}];
        if (near)
            cands.unshift(near);
        for (const o of others) {
            cands.push({x: o.x, y: o.y + o.h + g});
            cands.push({x: o.x + o.w + g, y: o.y});
            cands.push({x: o.x + o.w + g, y: wa.y + m});
        }
        const fits = c => c.x >= wa.x && c.y >= wa.y &&
            c.x + w <= wa.x + wa.w && c.y + h <= wa.y + wa.h &&
            !others.some(o => overlaps({x: c.x, y: c.y, w, h}, o, g - 1));
        const sorted = cands.slice(near ? 1 : 0).sort((a, b) => a.x - b.x || a.y - b.y);
        if (near && fits(near))
            return near;
        const spot = sorted.find(fits);
        return spot ?? {x: wa.x + (wa.w - w) / 2, y: wa.y + (wa.h - h) / 2};
    }

    _snapContext(frame, r) {
        const wa = this._workAreaFor(r);
        const g = this.settings.get_int('gap');
        const others = [...this.frames.values()]
            .filter(f => f !== frame && f.visible)
            .map(f => ({x: f.x, y: f.y, w: f.width, h: f.height}));
        return {wa, g, others};
    }

    snapMove(frame, r) {
        if (!this.settings.get_boolean('snap'))
            return this._clampRect(r);
        const {wa, g, others} = this._snapContext(frame, r);
        const xs = [wa.x + g, wa.x + wa.w - g - r.w];
        const ys = [wa.y + g, wa.y + wa.h - g - r.h];
        for (const o of others) {
            const nearV = r.y < o.y + o.h + SNAP_DISTANCE * 4 && o.y < r.y + r.h + SNAP_DISTANCE * 4;
            const nearH = r.x < o.x + o.w + SNAP_DISTANCE * 4 && o.x < r.x + r.w + SNAP_DISTANCE * 4;
            if (nearV)
                xs.push(o.x + o.w + g, o.x - g - r.w);
            if (nearH)
                ys.push(o.y + o.h + g, o.y - g - r.h);
            // align edges with widgets anywhere in the same row / column
            xs.push(o.x, o.x + o.w - r.w);
            ys.push(o.y, o.y + o.h - r.h);
        }
        const best = (v, cands) => {
            let out = v, d = SNAP_DISTANCE + 1;
            for (const c of cands) {
                if (Math.abs(c - v) < d) {
                    d = Math.abs(c - v);
                    out = c;
                }
            }
            return out;
        };
        return this._clampRect({...r, x: best(r.x, xs), y: best(r.y, ys)});
    }

    snapResize(frame, r) {
        if (!this.settings.get_boolean('snap'))
            return r;
        const {wa, g, others} = this._snapContext(frame, r);
        const rights = [wa.x + wa.w - g];
        const bottoms = [wa.y + wa.h - g];
        for (const o of others) {
            rights.push(o.x + o.w, o.x - g);
            bottoms.push(o.y + o.h, o.y - g);
        }
        const snap1 = (edge, cands) => {
            for (const c of cands) {
                if (Math.abs(c - edge) <= SNAP_DISTANCE)
                    return c;
            }
            return edge;
        };
        return {
            ...r,
            w: snap1(r.x + r.w, rights) - r.x,
            h: snap1(r.y + r.h, bottoms) - r.y,
        };
    }

    // --- context menu ------------------------------------------------------------

    _buildMenu() {
        this._menu = new PopupMenu.PopupMenu(Main.layoutManager.dummyCursor, 0, St.Side.TOP);
        this._menu.actor.add_style_class_name('background-menu');
        Main.layoutManager.uiGroup.add_child(this._menu.actor);
        this._menu.actor.hide();
        this._menuManager = new PopupMenu.PopupMenuManager(this.layer);
        this._menuManager.addMenu(this._menu);
    }

    /** @param {Function?} where returns the [x, y] to drop the new widget at, or null */
    _addWidgetSubmenu(menu, where = null, position = undefined) {
        const sub = new PopupMenu.PopupSubMenuMenuItem('Add Widget', false);
        for (const W of WIDGETS) {
            const item = new PopupMenu.PopupImageMenuItem(W.title, W.icon);
            item.connect('activate', () => this.addWidget(W.type, where?.() ?? null));
            sub.menu.addMenuItem(item);
        }
        menu.addMenuItem(sub, position);
        return sub;
    }

    openMenu(frame, x, y) {
        const menu = this._menu;
        menu.removeAll();
        const W = frame.WidgetClass;

        const header = new PopupMenu.PopupMenuItem(W.title, {reactive: false});
        header.label.set_style('font-weight: bold;');
        menu.addMenuItem(header);

        const before = menu.numMenuItems;
        try {
            frame.widget.buildMenu(menuBuilder(menu));
        } catch (e) {
            console.error(`gnomlets: ${W.type} menu: ${e.message}`);
        }
        if (menu.numMenuItems > before)
            menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        const sizeSub = new PopupMenu.PopupSubMenuMenuItem('Size', false);
        const names = {small: 'Small', medium: 'Medium', large: 'Large'};
        for (const [preset, [w, h]] of Object.entries(W.sizes)) {
            const item = new PopupMenu.PopupMenuItem(`${names[preset] ?? preset}  (${w}×${h})`);
            if (frame.width === w && frame.height === h)
                item.setOrnament(PopupMenu.Ornament.CHECK);
            else
                item.setOrnament(PopupMenu.Ornament.NONE);
            item.connect('activate', () => this.resizeTo(frame, preset));
            sizeSub.menu.addMenuItem(item);
        }
        menu.addMenuItem(sizeSub);
        this._addWidgetSubmenu(menu);
        menu.addAction('Duplicate', () => this.duplicate(frame));
        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        const lock = new PopupMenu.PopupSwitchMenuItem('Lock Widgets', this.locked);
        lock.connect('toggled', (_i, v) => this.settings.set_boolean('locked', v));
        menu.addMenuItem(lock);
        menu.addAction('Widget Settings…', () => this.openPrefs(frame.model.id));
        menu.addAction('Remove Widget', () => this.remove(frame));

        Main.layoutManager.setDummyCursorGeometry(x, y, 0, 0);
        menu.open(true);
    }

    // --- desktop (background) right-click menu ---------------------------------

    _setupBackgroundMenus() {
        this._bgItems = new Set();
        this._injections = new InjectionManager();
        const self = this;
        // new backgrounds (monitor or wallpaper changes) get their menu through this method
        this._injections.overrideMethod(Main.layoutManager, '_addBackgroundMenu', original => function (bgManager) {
            original.call(this, bgManager);
            self._decorateBackgroundMenu(bgManager.backgroundActor);
        });
        for (const bgm of Main.layoutManager._bgManagers ?? [])
            this._decorateBackgroundMenu(bgm.backgroundActor);
    }

    _decorateBackgroundMenu(actor) {
        const menu = actor?._backgroundMenu;
        if (!menu || menu._gnomletsDecorated)
            return;
        menu._gnomletsDecorated = true;
        // first in the menu; new widgets appear where the menu was opened
        const sub = this._addWidgetSubmenu(menu, () => {
            const c = Main.layoutManager.dummyCursor;
            return [c.x, c.y];
        }, 0);
        const settings = new PopupMenu.PopupMenuItem('Widget Settings…');
        settings.connect('activate', () => this.openPrefs());
        menu.addMenuItem(settings, 1);
        const sep = new PopupMenu.PopupSeparatorMenuItem();
        menu.addMenuItem(sep, 2);
        for (const it of [sub, settings, sep]) {
            this._bgItems.add(it);
            it.connect('destroy', () => this._bgItems?.delete(it));
        }
    }

    _teardownBackgroundMenus() {
        this._injections?.clear();
        this._injections = null;
        for (const it of [...(this._bgItems ?? [])])
            it.destroy();
        this._bgItems = null;
        for (const bgm of Main.layoutManager._bgManagers ?? []) {
            const menu = bgm.backgroundActor?._backgroundMenu;
            if (menu)
                delete menu._gnomletsDecorated;
        }
    }
}

export default class GnomletsExtension extends Extension {
    enable() {
        this._manager = new Manager(this);
    }

    disable() {
        this._manager?.destroy();
        this._manager = null;
        Sys.destroyAll();
        destroySession();
    }
}
