import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';
import Soup from 'gi://Soup?version=3.0';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {CATALOG, CATALOG_BY_TYPE} from './lib/catalog.js';
import {THEME_IDS, themeLabel} from './lib/themes.js';

const NOTE_COLORS = [['theme', 'Theme'], ['yellow', 'Yellow'], ['green', 'Green'], ['blue', 'Blue'], ['pink', 'Pink'], ['purple', 'Purple']];

const HAS_SETTINGS = new Set(['clock', 'analog', 'weather', 'calendar', 'processes', 'note']);

function newId() {
    return `w${GLib.uuid_string_random().slice(0, 8)}`;
}

/** Reads, edits and writes the widgets list without clobbering changes made by the shell. */
class Store {
    constructor(settings) {
        this.settings = settings;
    }

    list() {
        try {
            const l = JSON.parse(this.settings.get_string('widgets'));
            return Array.isArray(l) ? l.filter(m => m && CATALOG_BY_TYPE[m.type]) : [];
        } catch {
            return [];
        }
    }

    write(list) {
        this.settings.set_string('widgets', JSON.stringify(list));
    }

    get(id) {
        return this.list().find(m => m.id === id) ?? null;
    }

    setOpts(id, patch) {
        const list = this.list();
        const m = list.find(x => x.id === id);
        if (!m)
            return;
        m.opts = {...(m.opts ?? {}), ...patch};
        this.write(list);
    }

    add(type) {
        const c = CATALOG_BY_TYPE[type];
        const [w, h] = c.sizes[c.size];
        const list = this.list();
        const id = newId();
        list.push({id, type, x: -1, y: -1, w, h, opts: {}});
        this.write(list);
        return id;
    }

    remove(id) {
        this.write(this.list().filter(m => m.id !== id));
    }
}

// --- Open-Meteo geocoding --------------------------------------------------

let _session = null;
function geocode(query) {
    _session ??= new Soup.Session({user_agent: 'gnomlets/1.0', timeout: 15});
    const url = `https://geocoding-api.open-meteo.com/v1/search?count=8&language=en&format=json&name=${encodeURIComponent(query)}`;
    return new Promise((resolve, reject) => {
        const msg = Soup.Message.new('GET', url);
        _session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null, (s, res) => {
            try {
                const bytes = s.send_and_read_finish(res);
                if (msg.get_status() !== Soup.Status.OK)
                    throw new Error(`HTTP ${msg.get_status()}`);
                const data = JSON.parse(new TextDecoder().decode(bytes.get_data()));
                resolve(data.results ?? []);
            } catch (e) {
                reject(e);
            }
        });
    });
}

function placeLabel(r) {
    return [r.name, r.admin1, r.country].filter(Boolean).join(', ');
}

/**
 * An entry that searches places as you type and lists them below; picking one
 * calls onPick with the Open-Meteo result.
 */
function placeSearch(group, title, onPick) {
    const entry = new Adw.EntryRow({title, show_apply_button: true});
    group.add(entry);
    const results = [];
    let seq = 0;
    const clear = () => {
        for (const r of results.splice(0))
            group.remove(r);
    };
    const search = async () => {
        const q = entry.get_text().trim();
        clear();
        if (q.length < 2)
            return;
        const mine = ++seq;
        try {
            const found = await geocode(q);
            if (mine !== seq)
                return;
            if (!found.length) {
                const row = new Adw.ActionRow({title: 'No places found'});
                group.add(row);
                results.push(row);
            }
            for (const place of found) {
                const row = new Adw.ActionRow({
                    title: placeLabel(place),
                    subtitle: `${place.latitude.toFixed(2)}, ${place.longitude.toFixed(2)} · ${place.timezone ?? ''}`,
                    activatable: true,
                });
                row.add_prefix(new Gtk.Image({icon_name: 'mark-location-symbolic'}));
                row.connect('activated', () => {
                    onPick(place);
                    entry.set_text('');
                    clear();
                });
                group.add(row);
                results.push(row);
            }
        } catch (e) {
            const row = new Adw.ActionRow({title: `Search failed: ${e.message}`});
            group.add(row);
            results.push(row);
        }
    };
    entry.connect('apply', search);
    entry.connect('entry-activated', search);
}

// --- per-widget settings -----------------------------------------------------

function comboRow(title, choices, current, onChange) {
    const model = Gtk.StringList.new(choices.map(c => c[1]));
    const row = new Adw.ComboRow({title, model});
    row.set_selected(Math.max(0, choices.findIndex(c => c[0] === current)));
    row.connect('notify::selected', () => onChange(choices[row.get_selected()][0]));
    return row;
}

function switchRow(title, active, onChange, subtitle = '') {
    const row = new Adw.SwitchRow({title, subtitle, active: !!active});
    row.connect('notify::active', () => onChange(row.get_active()));
    return row;
}

function buildWidgetSettings(store, model, group) {
    const id = model.id;
    const o = model.opts ?? {};
    const set = patch => store.setOpts(id, patch);
    const opt = () => store.get(id)?.opts ?? {};

    switch (model.type) {
    case 'clock':
    case 'analog': {
        if (model.type === 'clock') {
            group.add(comboRow('Time format', [['system', 'Like the system'], ['24h', '24-hour'], ['12h', '12-hour']],
                o.format ?? 'system', v => set({format: v})));
        } else {
            group.add(switchRow('Numbers', o.numbers ?? true, v => set({numbers: v})));
        }
        group.add(switchRow(model.type === 'clock' ? 'Show seconds' : 'Second hand',
            o.seconds ?? model.type === 'analog', v => set({seconds: v})));
        const tzRow = new Adw.ActionRow({
            title: 'Time zone',
            subtitle: o.timezone ? `${o.city || o.timezone} (${o.timezone})` : 'Local time',
        });
        const local = new Gtk.Button({label: 'Use local time', valign: Gtk.Align.CENTER, sensitive: !!o.timezone});
        local.connect('clicked', () => {
            set({timezone: '', city: ''});
            tzRow.set_subtitle('Local time');
            local.set_sensitive(false);
        });
        tzRow.add_suffix(local);
        group.add(tzRow);
        placeSearch(group, 'Show the time of another city…', place => {
            set({timezone: place.timezone ?? '', city: place.name});
            tzRow.set_subtitle(`${place.name} (${place.timezone})`);
            local.set_sensitive(true);
        });
        break;
    }
    case 'weather': {
        const locRow = new Adw.ActionRow({
            title: 'Location',
            subtitle: o.latitude !== null && o.latitude !== undefined
                ? `${o.name || 'Unnamed'} (${Number(o.latitude).toFixed(2)}, ${Number(o.longitude).toFixed(2)})`
                : 'Not set — search for a city below',
        });
        locRow.add_prefix(new Gtk.Image({icon_name: 'mark-location-symbolic'}));
        group.add(locRow);
        placeSearch(group, 'Search for a city…', place => {
            set({name: place.name, latitude: place.latitude, longitude: place.longitude});
            locRow.set_subtitle(`${place.name} (${place.latitude.toFixed(2)}, ${place.longitude.toFixed(2)})`);
        });
        const name = new Adw.EntryRow({title: 'Name shown on the widget', text: o.name ?? '', show_apply_button: true});
        name.connect('apply', () => set({name: name.get_text()}));
        group.add(name);
        group.add(comboRow('Units', [['celsius', 'Celsius'], ['fahrenheit', 'Fahrenheit']],
            o.units ?? 'celsius', v => set({units: v})));
        break;
    }
    case 'calendar':
        group.add(switchRow('Show events', o.events ?? true, v => set({events: v}),
            'From the calendars in GNOME Online Accounts and Evolution'));
        break;
    case 'processes':
        group.add(comboRow('Sort by', [['cpu', 'CPU'], ['mem', 'Memory']], o.sort ?? 'cpu', v => set({sort: v})));
        break;
    case 'note': {
        group.add(comboRow('Color', NOTE_COLORS, o.color ?? 'yellow', v => set({color: v})));
        const view = new Gtk.TextView({
            wrap_mode: Gtk.WrapMode.WORD_CHAR,
            top_margin: 10, bottom_margin: 10, left_margin: 12, right_margin: 12,
        });
        view.buffer.set_text(o.text ?? 'Double-click to write a note.', -1);
        let timer = 0;
        view.buffer.connect('changed', () => {
            if (timer)
                GLib.source_remove(timer);
            timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 400, () => {
                timer = 0;
                const b = view.buffer;
                const text = b.get_text(b.get_start_iter(), b.get_end_iter(), false);
                if (text !== opt().text)
                    set({text});
                return GLib.SOURCE_REMOVE;
            });
        });
        const frame = new Gtk.Frame({child: view, margin_top: 6, height_request: 120});
        frame.add_css_class('view');
        const row = new Adw.PreferencesRow({activatable: false, child: frame});
        group.add(row);
        break;
    }
    default:
        break;
    }
}

// --- pages ---------------------------------------------------------------

function galleryPage(store, onAdded) {
    const page = new Adw.PreferencesPage({title: 'Gallery', icon_name: 'view-grid-symbolic'});
    const group = new Adw.PreferencesGroup({
        title: 'Add Widgets',
        description: 'Pick a widget to put it on your desktop. Then drag it anywhere, resize it from its bottom-right corner, and right-click it for options. You can also right-click the desktop → Add Widget.',
    });
    page.add(group);
    const flow = new Gtk.FlowBox({
        selection_mode: Gtk.SelectionMode.NONE,
        column_spacing: 12, row_spacing: 12,
        min_children_per_line: 2, max_children_per_line: 4,
        homogeneous: true,
        margin_top: 6,
    });
    for (const c of CATALOG) {
        const box = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL, spacing: 6,
            margin_top: 16, margin_bottom: 16, margin_start: 14, margin_end: 14,
        });
        box.append(new Gtk.Image({icon_name: c.icon, pixel_size: 36, margin_bottom: 4}));
        const title = new Gtk.Label({label: c.title, css_classes: ['heading']});
        box.append(title);
        const desc = new Gtk.Label({
            label: c.description, wrap: true, justify: Gtk.Justification.CENTER,
            css_classes: ['dim-label', 'caption'], vexpand: true, valign: Gtk.Align.START,
            max_width_chars: 22, lines: 4, ellipsize: 3,
        });
        box.append(desc);
        const add = new Gtk.Button({label: 'Add', halign: Gtk.Align.CENTER, css_classes: ['pill', 'suggested-action'], margin_top: 6});
        add.connect('clicked', () => {
            const id = store.add(c.type);
            onAdded?.(id);
            add.set_label('Added ✓');
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1200, () => {
                add.set_label('Add');
                return GLib.SOURCE_REMOVE;
            });
        });
        box.append(add);
        const card = new Gtk.Frame({child: box, css_classes: ['card']});
        flow.append(card);
    }
    group.add(flow);
    return page;
}

class DesktopPage {
    constructor(store, settings) {
        this.store = store;
        this.page = new Adw.PreferencesPage({title: 'On Desktop', icon_name: 'user-desktop-symbolic'});
        this._groups = [];
        this._signature = '';
        this.rebuild();
        this._changedId = settings.connect('changed::widgets', () => this.rebuildIfNeeded());
        this.page.connect('destroy', () => settings.disconnect(this._changedId));
    }

    _sig(list) {
        return list.map(m => `${m.id}:${m.type}`).join(',');
    }

    rebuildIfNeeded() {
        // only when widgets are added or removed: rebuilding while typing loses focus
        if (this._sig(this.store.list()) !== this._signature)
            this.rebuild();
    }

    rebuild(expandId = null) {
        for (const g of this._groups.splice(0))
            this.page.remove(g);
        const list = this.store.list();
        this._signature = this._sig(list);
        this.rows = new Map();

        const head = new Adw.PreferencesGroup({
            title: 'Widgets on Your Desktop',
            description: list.length ? 'Expand a widget to change its settings.' : 'No widgets yet. Add some from the Gallery.',
        });
        this.page.add(head);
        this._groups.push(head);
        const counts = {};
        for (const m of list) {
            const c = CATALOG_BY_TYPE[m.type];
            counts[m.type] = (counts[m.type] ?? 0) + 1;
            const title = c.title + (list.filter(x => x.type === m.type).length > 1 ? ` ${counts[m.type]}` : '');
            const configurable = HAS_SETTINGS.has(m.type);
            const exp = configurable
                ? new Adw.ExpanderRow({title, subtitle: this._subtitle(m)})
                : new Adw.ActionRow({title, subtitle: this._subtitle(m)});
            exp.add_prefix(new Gtk.Image({icon_name: c.icon}));
            const remove = new Gtk.Button({
                icon_name: 'user-trash-symbolic', valign: Gtk.Align.CENTER,
                tooltip_text: 'Remove from desktop', css_classes: ['flat'],
            });
            remove.connect('clicked', () => this.store.remove(m.id));
            exp.add_suffix(remove);

            if (configurable)
                buildWidgetSettings(this.store, m, new InnerGroup(exp));
            head.add(exp);
            this.rows.set(m.id, exp);
            if (expandId === m.id)
                exp.set_expanded(true);
        }
    }

    _subtitle(m) {
        const o = m.opts ?? {};
        if (m.type === 'weather')
            return o.name || (o.latitude !== null && o.latitude !== undefined ? 'Custom location' : 'Location not set');
        if ((m.type === 'clock' || m.type === 'analog') && o.timezone)
            return o.city || o.timezone;
        if (m.type === 'note')
            return (o.text ?? '').split('\n')[0].slice(0, 40);
        return `${m.w}×${m.h}`;
    }

    focus(id) {
        const row = this.rows?.get(id);
        if (!row)
            return;
        row.set_expanded?.(true);
        row.grab_focus();
    }
}

/** Adapter so buildWidgetSettings can add/remove rows inside an ExpanderRow. */
class InnerGroup {
    constructor(expander) {
        this.exp = expander;
    }

    add(row) {
        this.exp.add_row(row);
    }

    remove(row) {
        this.exp.remove(row);
    }
}

function appearancePage(settings, store) {
    const page = new Adw.PreferencesPage({title: 'Appearance', icon_name: 'applications-graphics-symbolic'});

    const look = new Adw.PreferencesGroup({title: 'Look'});
    page.add(look);
    const themes = THEME_IDS.map(id => [id, themeLabel(id)]);
    look.add(comboRow('Theme', themes, settings.get_string('theme'), v => settings.set_string('theme', v)));
    const opacity = new Adw.SpinRow({
        title: 'Card opacity',
        subtitle: 'Percent; lower lets more of the wallpaper through',
        adjustment: new Gtk.Adjustment({lower: 30, upper: 100, step_increment: 5, page_increment: 10}),
    });
    settings.bind('opacity', opacity, 'value', Gio.SettingsBindFlags.DEFAULT);
    look.add(opacity);

    const layout = new Adw.PreferencesGroup({title: 'Arranging'});
    page.add(layout);
    const snap = new Adw.SwitchRow({title: 'Snap to other widgets', subtitle: 'Widgets stick to each other’s edges and to the screen edges while you drag them'});
    settings.bind('snap', snap, 'active', Gio.SettingsBindFlags.DEFAULT);
    layout.add(snap);
    const gap = new Adw.SpinRow({
        title: 'Spacing',
        subtitle: 'Pixels between snapped widgets',
        adjustment: new Gtk.Adjustment({lower: 0, upper: 64, step_increment: 1, page_increment: 4}),
    });
    settings.bind('gap', gap, 'value', Gio.SettingsBindFlags.DEFAULT);
    layout.add(gap);
    const locked = new Adw.SwitchRow({title: 'Lock widgets', subtitle: 'Prevents moving and resizing them by accident'});
    settings.bind('locked', locked, 'active', Gio.SettingsBindFlags.DEFAULT);
    layout.add(locked);

    const reset = new Adw.ActionRow({title: 'Tidy up', subtitle: 'Arrange every widget again in columns from the top-left corner'});
    const btn = new Gtk.Button({label: 'Tidy Up', valign: Gtk.Align.CENTER});
    btn.connect('clicked', () => store.write(store.list().map(m => ({...m, x: -1, y: -1}))));
    reset.add_suffix(btn);
    layout.add(reset);

    const removeAll = new Adw.ActionRow({title: 'Remove all widgets'});
    const rbtn = new Gtk.Button({label: 'Remove All', valign: Gtk.Align.CENTER, css_classes: ['destructive-action']});
    rbtn.connect('clicked', () => store.write([]));
    removeAll.add_suffix(rbtn);
    layout.add(removeAll);
    return page;
}

export default class GnomletsPrefs extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const store = new Store(settings);
        window.set_default_size(760, 720);
        window.set_search_enabled(true);

        const desktop = new DesktopPage(store, settings);
        window.add(galleryPage(store));
        window.add(desktop.page);
        window.add(appearancePage(settings, store));

        const focus = settings.get_string('prefs-focus');
        if (focus) {
            settings.set_string('prefs-focus', '');
            window.set_visible_page(desktop.page);
            desktop.focus(focus);
        } else if (store.list().length) {
            window.set_visible_page(desktop.page);
        }
        // the window stays open while the shell asks for another widget's settings
        const focusId = settings.connect('changed::prefs-focus', () => {
            const id = settings.get_string('prefs-focus');
            if (!id)
                return;
            settings.set_string('prefs-focus', '');
            window.set_visible_page(desktop.page);
            desktop.focus(id);
            window.present();
        });
        window.connect('close-request', () => {
            settings.disconnect(focusId);
            return false;
        });
    }
}
