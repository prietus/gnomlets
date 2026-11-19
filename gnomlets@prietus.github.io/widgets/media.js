import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';

import {Gnomlet} from './base.js';
import * as D from '../lib/draw.js';
import {download} from '../lib/http.js';

const MPRIS_PREFIX = 'org.mpris.MediaPlayer2.';
const MPRIS_PATH = '/org/mpris/MediaPlayer2';

const RootIface = `<node><interface name="org.mpris.MediaPlayer2">
  <method name="Raise"/>
  <property name="Identity" type="s" access="read"/>
  <property name="CanRaise" type="b" access="read"/>
</interface></node>`;

const PlayerIface = `<node><interface name="org.mpris.MediaPlayer2.Player">
  <method name="PlayPause"/>
  <method name="Next"/>
  <method name="Previous"/>
  <property name="PlaybackStatus" type="s" access="read"/>
  <property name="Metadata" type="a{sv}" access="read"/>
  <property name="CanGoNext" type="b" access="read"/>
  <property name="CanGoPrevious" type="b" access="read"/>
  <property name="CanPlay" type="b" access="read"/>
</interface></node>`;

const RootProxy = Gio.DBusProxy.makeProxyWrapper(RootIface);
const PlayerProxy = Gio.DBusProxy.makeProxyWrapper(PlayerIface);

function unpack(v) {
    try {
        return v?.deepUnpack?.() ?? v;
    } catch {
        return null;
    }
}

class Player {
    constructor(busName, onChange) {
        this.busName = busName;
        this.lastActive = 0;
        this._onChange = onChange;
        this._pos = {value: 0, at: 0};
        this.root = new RootProxy(Gio.DBus.session, busName, MPRIS_PATH, (p, e) => {
            if (!e)
                onChange();
        }, null, Gio.DBusProxyFlags.NONE);
        this.player = new PlayerProxy(Gio.DBus.session, busName, MPRIS_PATH, (p, e) => {
            if (e)
                return;
            this._propsId = p.connect('g-properties-changed', () => {
                if (this.playing)
                    this.lastActive = Date.now();
                this.fetchPosition();
                onChange();
            });
            if (this.playing)
                this.lastActive = Date.now();
            this.fetchPosition();
            onChange();
        }, null, Gio.DBusProxyFlags.NONE);
    }

    get identity() {
        return this.root.Identity ?? this.busName.slice(MPRIS_PREFIX.length).split('.')[0];
    }

    get playing() {
        return this.player.PlaybackStatus === 'Playing';
    }

    get metadata() {
        const m = this.player.Metadata ?? {};
        const get = k => unpack(m[k]);
        let artist = get('xesam:artist');
        if (Array.isArray(artist))
            artist = artist.join(', ');
        return {
            title: get('xesam:title') ?? '',
            artist: artist ?? '',
            album: get('xesam:album') ?? '',
            art: get('mpris:artUrl') ?? '',
            length: Number(get('mpris:length') ?? 0) / 1e6,
            trackId: String(get('mpris:trackid') ?? ''),
        };
    }

    get position() {
        const extra = this.playing && this._pos.at ? (Date.now() - this._pos.at) / 1000 : 0;
        return this._pos.value + extra;
    }

    fetchPosition() {
        Gio.DBus.session.call(this.busName, MPRIS_PATH, 'org.freedesktop.DBus.Properties', 'Get',
            new GLib.Variant('(ss)', ['org.mpris.MediaPlayer2.Player', 'Position']),
            null, Gio.DBusCallFlags.NONE, 2000, null, (conn, res) => {
                try {
                    const [v] = conn.call_finish(res).deepUnpack();
                    this._pos = {value: Number(v.unpack()) / 1e6, at: Date.now()};
                } catch {
                    this._pos = {value: 0, at: 0};
                }
            });
    }

    playPause() {
        this.player.PlayPauseAsync?.().catch(() => {});
        this.lastActive = Date.now();
    }

    next() {
        this.player.NextAsync?.().catch(() => {});
    }

    previous() {
        this.player.PreviousAsync?.().catch(() => {});
    }

    raise() {
        this.root.RaiseAsync?.().catch(() => {});
    }

    destroy() {
        if (this._propsId)
            this.player.disconnect(this._propsId);
    }
}

function coverCacheDir() {
    const dir = GLib.build_filenamev([GLib.get_user_cache_dir(), 'gnomlets', 'covers']);
    GLib.mkdir_with_parents(dir, 0o700);
    return dir;
}

export class MediaWidget extends Gnomlet {
    static type = 'media';

    enable() {
        this._players = new Map();
        this._cover = new St.Widget({visible: false, reactive: false});
        this.host.overlay.add_child(this._cover);
        this._coverPath = null;
        this._coverFor = null;

        const bus = Gio.DBus.session;
        this._ownerSub = bus.signal_subscribe('org.freedesktop.DBus', 'org.freedesktop.DBus',
            'NameOwnerChanged', '/org/freedesktop/DBus', null, Gio.DBusSignalFlags.NONE,
            (_c, _s, _p, _i, _sig, params) => {
                const [name, , newOwner] = params.deepUnpack();
                if (!name.startsWith(MPRIS_PREFIX))
                    return;
                if (newOwner)
                    this._add(name);
                else
                    this._remove(name);
            });
        bus.call('org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus', 'ListNames',
            null, null, Gio.DBusCallFlags.NONE, -1, null, (c, res) => {
                try {
                    const [names] = c.call_finish(res).deepUnpack();
                    names.filter(n => n.startsWith(MPRIS_PREFIX)).forEach(n => this._add(n));
                } catch (e) {
                    console.warn(`gnomlets: media: ${e.message}`);
                }
            });
        // tick the progress bar; refresh the real position now and then
        let n = 0;
        this.every(1000, () => {
            const p = this._current();
            if (p?.playing) {
                if (++n % 5 === 0)
                    p.fetchPosition();
                this.host.repaint();
            }
        });
        this.layout(this.host.width, this.host.height, this.host.theme);
    }

    disable() {
        super.disable();
        if (this._ownerSub)
            Gio.DBus.session.signal_unsubscribe(this._ownerSub);
        this._ownerSub = 0;
        for (const p of this._players.values())
            p.destroy();
        this._players.clear();
        this._cover?.destroy();
        this._cover = null;
    }

    _add(name) {
        if (this._players.has(name))
            return;
        this._players.set(name, new Player(name, () => this._changed()));
    }

    _remove(name) {
        this._players.get(name)?.destroy();
        this._players.delete(name);
        this._changed();
    }

    _current() {
        const list = [...this._players.values()].filter(p => p.player.PlaybackStatus);
        if (!list.length)
            return null;
        const playing = list.filter(p => p.playing);
        const pool = playing.length ? playing : list;
        return pool.reduce((a, b) => (b.lastActive > a.lastActive ? b : a));
    }

    _changed() {
        if (!this._cover)
            return;
        const p = this._current();
        const art = p?.metadata.art ?? '';
        if (art !== this._coverFor) {
            this._coverFor = art;
            this._loadCover(art);
        }
        this.host.repaint();
    }

    async _loadCover(url) {
        let path = null;
        try {
            if (url.startsWith('file://'))
                path = Gio.File.new_for_uri(url).get_path();
            else if (url.startsWith('/'))
                path = url;
            else if (url.startsWith('http')) {
                const hash = GLib.compute_checksum_for_string(GLib.ChecksumType.MD5, url, -1);
                path = GLib.build_filenamev([coverCacheDir(), hash]);
                if (!GLib.file_test(path, GLib.FileTest.EXISTS))
                    await download(url, path);
            }
        } catch (e) {
            console.warn(`gnomlets: cover: ${e.message}`);
            path = null;
        }
        if (url !== this._coverFor || !this._cover)
            return;
        this._coverPath = path && GLib.file_test(path, GLib.FileTest.EXISTS) ? path : null;
        this._styleCover();
        this.layout(this.host.width, this.host.height, this.host.theme);
        this.host.repaint();
    }

    _styleCover() {
        if (!this._cover)
            return;
        const r = Math.max(4, Math.min(12, this.host.theme.radius * 0.5));
        if (this._coverPath) {
            const uri = Gio.File.new_for_path(this._coverPath).get_uri();
            this._cover.set_style(`background-image: url("${uri}"); background-size: cover; border-radius: ${r}px;`);
        }
        this._cover.visible = !!this._coverPath && !!this._current();
    }

    _rects(w, h) {
        const pad = Math.max(12, Math.min(20, Math.min(w, h) * 0.08));
        if (w > h * 1.5) {
            const art = h - pad * 2;
            return {pad, art: [pad, pad, art, art], text: [pad * 2 + art, pad, w - art - pad * 3, h - pad * 2]};
        }
        if (h > w * 1.4 || (w > 280 && h > 280)) {
            const art = Math.min(w - pad * 2, h * 0.45);
            return {pad, art: [(w - art) / 2, pad, art, art], text: [pad, pad * 1.6 + art, w - pad * 2, h - art - pad * 2.6]};
        }
        const art = Math.min(h * 0.38, w * 0.38);
        return {pad, art: [pad, pad, art, art], text: [pad, pad * 1.5 + art, w - pad * 2, h - art - pad * 2.5], compact: true};
    }

    layout(w, h, t) {
        if (!this._cover)
            return;
        const {art} = this._rects(w, h);
        this._cover.set_position(Math.round(art[0]), Math.round(art[1]));
        this._cover.set_size(Math.round(art[2]), Math.round(art[3]));
        this._styleCover(t);
    }

    click(x, y) {
        const p = this._current();
        if (!p)
            return false;
        for (const [kind, r] of this._hits ?? []) {
            if (x >= r[0] && x <= r[0] + r[2] && y >= r[1] && y <= r[1] + r[3]) {
                if (kind === 'play')
                    p.playPause();
                else if (kind === 'next')
                    p.next();
                else if (kind === 'prev')
                    p.previous();
                else if (kind === 'raise')
                    p.raise();
                return true;
            }
        }
        return false;
    }

    buildMenu(m) {
        const p = this._current();
        if (p)
            m.action(`Open ${p.identity}`, () => p.raise());
    }

    draw(cr, w, h, t) {
        this._hits = [];
        const p = this._current();
        const {pad, art, text, compact} = this._rects(w, h);
        if (this._cover)
            this._cover.visible = !!p && !!this._coverPath;
        if (!p) {
            this._noteGlyph(cr, w / 2, h / 2 - 10, Math.min(w, h) * 0.28, t);
            D.text(cr, 'Nothing playing', w / 2, h - pad, {size: 13, color: t.dim, align: 'center', valign: 'bottom', theme: t});
            return;
        }
        const md = p.metadata;
        // placeholder behind the cover (also shown while it loads)
        if (!this._coverPath) {
            D.setColor(cr, t.faint);
            D.roundRect(cr, ...art, Math.max(4, Math.min(12, t.radius * 0.5)));
            cr.fill();
            this._noteGlyph(cr, art[0] + art[2] / 2, art[1] + art[3] / 2, art[2] * 0.45, t);
        }
        this._hits.push(['raise', art]);

        const [tx, ty, tw, th] = text;
        const fs = Math.max(11, Math.min(17, Math.min(w, h) * 0.085));
        if (compact) {
            // the player name next to the cover
            D.text(cr, p.identity.toUpperCase(), art[0] + art[2] + pad * 0.7, art[1] + 2,
                {size: fs * 0.7, weight: D.Weight.BOLD, color: p.playing ? t.accent : t.dim, maxWidth: w - art[2] - pad * 2.7, theme: t});
        } else {
            D.text(cr, p.identity.toUpperCase(), tx, ty, {size: fs * 0.7, weight: D.Weight.BOLD, color: p.playing ? t.accent : t.dim, maxWidth: tw, theme: t});
        }
        let y = compact ? ty : ty + fs * 1.15;
        D.text(cr, md.title || 'Unknown title', tx, y, {size: fs, weight: D.Weight.BOLD, color: t.fg, maxWidth: tw, theme: t});
        y += fs * 1.3;
        if (md.artist) {
            D.text(cr, md.artist, tx, y, {size: fs * 0.85, color: t.dim, maxWidth: tw, theme: t});
            y += fs * 1.2;
        }

        // controls at the bottom of the text area
        const cs = Math.max(14, Math.min(30, th * 0.22, tw * 0.1));
        const cyc = ty + th - cs * 0.6;
        const centers = [tx + tw / 2 - cs * 2.2, tx + tw / 2, tx + tw / 2 + cs * 2.2];
        const dim = c => (c ? t.fg : D.withAlpha(t.fg, 0.3));
        D.skipGlyph(cr, centers[0], cyc, cs * 0.7, dim(p.player.CanGoPrevious), false);
        if (p.playing)
            D.pauseGlyph(cr, centers[1], cyc, cs, t.fg);
        else
            D.playGlyph(cr, centers[1], cyc, cs, t.fg);
        D.skipGlyph(cr, centers[2], cyc, cs * 0.7, dim(p.player.CanGoNext), true);
        this._hits.push(['prev', [centers[0] - cs, cyc - cs, cs * 2, cs * 2]]);
        this._hits.push(['play', [centers[1] - cs, cyc - cs, cs * 2, cs * 2]]);
        this._hits.push(['next', [centers[2] - cs, cyc - cs, cs * 2, cs * 2]]);

        // progress
        const by = cyc - cs * 1.1;
        if (md.length > 0 && by - y > fs * 0.6) {
            const pos = Math.min(md.length, p.position);
            D.bar(cr, tx, by - 3, tw, 4, pos / md.length, t.fg, t);
            if (by - y > fs * 1.8) {
                const mmss = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
                D.text(cr, mmss(pos), tx, by - 8, {size: fs * 0.65, color: t.dim, valign: 'bottom', tnum: true, theme: t});
                D.text(cr, `-${mmss(md.length - pos)}`, tx + tw, by - 8, {size: fs * 0.65, color: t.dim, align: 'right', valign: 'bottom', tnum: true, theme: t});
            }
        }
    }

    _noteGlyph(cr, cx, cy, s, t) {
        D.setColor(cr, t.dim, 0.6);
        cr.setLineWidth(Math.max(1.5, s * 0.08));
        cr.moveTo(cx - s * 0.18, cy + s * 0.3);
        cr.lineTo(cx - s * 0.18, cy - s * 0.35);
        cr.lineTo(cx + s * 0.32, cy - s * 0.45);
        cr.lineTo(cx + s * 0.32, cy + s * 0.2);
        cr.stroke();
        D.circle(cr, cx - s * 0.3, cy + s * 0.3, s * 0.13, D.withAlpha(t.dim, 0.6));
        D.circle(cr, cx + s * 0.2, cy + s * 0.2, s * 0.13, D.withAlpha(t.dim, 0.6));
    }
}
