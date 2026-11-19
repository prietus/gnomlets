// The frame around each widget: the card, the drawing area, dragging,
// resizing with the corner grip and the context menu.
import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {cssColor} from './themes.js';
import {setColor} from './draw.js';

const DRAG_THRESHOLD = 5;
const GRIP = 26;

export const GnomletFrame = GObject.registerClass(
class GnomletFrame extends St.Widget {
    _init(manager, model, WidgetClass) {
        super._init({
            reactive: true,
            track_hover: true,
            style_class: 'gnomlet',
            x: model.x,
            y: model.y,
            width: model.w,
            height: model.h,
        });
        this.manager = manager;
        this.model = model;
        this.WidgetClass = WidgetClass;
        this.theme = manager.theme;

        this._card = new St.Widget({style_class: 'gnomlet-card'});
        this.add_child(this._card);

        this._area = new St.DrawingArea();
        this._area.connect('repaint', a => this._repaint(a));
        this.add_child(this._area);

        this.overlay = new St.Widget({x: 0, y: 0});
        this.add_child(this.overlay);

        this._grip = new St.DrawingArea({width: GRIP, height: GRIP, opacity: 0});
        this._grip.connect('repaint', a => this._repaintGrip(a));
        this.add_child(this._grip);

        this._grab = null;
        this._press = null;

        this.connect('notify::hover', () => this._updateGrip());
        this.connect('button-press-event', (_a, e) => this._onPress(e));
        this.connect('motion-event', (_a, e) => this._onMotion(e));
        this.connect('button-release-event', (_a, e) => this._onRelease(e));
        this.connect('scroll-event', (_a, e) => this._onScroll(e));
        this.connect('destroy', () => this._onDestroy());

        this.widget = new WidgetClass(this, model.opts);
        this._applyTheme();
        this._relayout();
        try {
            this.widget.enable();
        } catch (e) {
            console.error(`gnomlets: ${model.type}: ${e.message}\n${e.stack}`);
        }
    }

    // --- host API used by the widgets ---
    repaint() {
        this._area.queue_repaint();
    }

    saveOpts(opts) {
        this.model.opts = {...opts};
        this.manager.save();
    }

    /** Lets a widget paint its card in its own color (sticky notes). */
    setCardOverride(o) {
        this._override = o;
        this._applyTheme();
    }

    // --- called by the manager ---
    setTheme(theme) {
        this.theme = theme;
        this._applyTheme();
        this._relayout();
    }

    setModel(model) {
        const optsChanged = JSON.stringify(model.opts ?? {}) !== JSON.stringify(this.model.opts ?? {});
        this.model = model;
        if (!this._press) {
            this.set_position(model.x, model.y);
            this.set_size(model.w, model.h);
            this._relayout();
        }
        if (optsChanged) {
            this.widget.opts = {...this.WidgetClass.defaults, ...(model.opts ?? {})};
            this.widget.optsChanged();
            this.repaint();
        }
    }

    setGeometry(x, y, w, h) {
        this.set_position(Math.round(x), Math.round(y));
        if (w !== this.width || h !== this.height) {
            this.set_size(Math.round(w), Math.round(h));
            this._relayout();
        }
    }

    // --- internals ---
    _applyTheme() {
        const t = this.theme;
        const bg = this._override?.bg ?? t.bg;
        this._card.set_style(
            `background-color: ${cssColor(bg)};` +
            `border: 1px solid ${cssColor(t.border)};` +
            `border-radius: ${t.radius}px;` +
            'box-shadow: 0 8px 28px rgba(0,0,0,0.28);');
        this.overlay.set_style(`border-radius: ${t.radius}px;`);
        this._grip.queue_repaint();
    }

    _relayout() {
        const w = this.width, h = this.height;
        this._card.set_size(w, h);
        this._area.set_size(w, h);
        this.overlay.set_size(w, h);
        this._grip.set_position(w - GRIP, h - GRIP);
        try {
            this.widget?.layout(w, h, this.theme);
        } catch (e) {
            console.error(`gnomlets: ${this.model.type} layout: ${e.message}`);
        }
        this._area.queue_repaint();
    }

    _repaint(area) {
        const cr = area.get_context();
        const [w, h] = area.get_surface_size();
        try {
            this.widget.draw(cr, w, h, this.theme);
        } catch (e) {
            console.error(`gnomlets: ${this.model.type} draw: ${e.message}\n${e.stack}`);
        } finally {
            cr.$dispose();
        }
    }

    _repaintGrip(area) {
        const cr = area.get_context();
        const [w, h] = area.get_surface_size();
        const r = Math.min(this.theme.radius, 20);
        // a quarter arc that hugs the rounded corner, like macOS
        cr.setLineWidth(3.5);
        cr.setLineCap(1);
        setColor(cr, this.theme.dim, 0.9);
        const inset = 5;
        const cx = w - inset - r, cy = h - inset - r;
        cr.arc(cx, cy, Math.max(4, r), 0.08 * Math.PI, 0.42 * Math.PI);
        if (r < 6) {
            cr.newPath();
            cr.moveTo(w - inset, h - 16);
            cr.lineTo(w - inset, h - inset);
            cr.lineTo(w - 16, h - inset);
        }
        cr.stroke();
        cr.$dispose();
    }

    _updateGrip() {
        const show = (this.hover || this._press?.mode === 'resize') && !this.manager.locked;
        this._grip.ease({opacity: show ? 255 : 0, duration: 150});
    }

    _local(e) {
        const [sx, sy] = e.get_coords();
        const [ok, lx, ly] = this.transform_stage_point(sx, sy);
        return ok ? [lx, ly, sx, sy] : [sx - this.x, sy - this.y, sx, sy];
    }

    _onPress(e) {
        const button = e.get_button();
        const [lx, ly, sx, sy] = this._local(e);
        if (button === Clutter.BUTTON_SECONDARY) {
            this.manager.openMenu(this, sx, sy);
            return Clutter.EVENT_STOP;
        }
        if (button !== Clutter.BUTTON_PRIMARY || this._press)
            return Clutter.EVENT_PROPAGATE;

        const inGrip = lx > this.width - GRIP && ly > this.height - GRIP;
        this._press = {
            mode: inGrip && !this.manager.locked ? 'resize' : 'click',
            sx, sy, lx, ly,
            x0: this.x, y0: this.y, w0: this.width, h0: this.height,
            moved: false,
        };
        this._grab = global.stage.grab(this);
        this.manager.raise(this);
        return Clutter.EVENT_STOP;
    }

    _onMotion(e) {
        const p = this._press;
        if (!p)
            return Clutter.EVENT_PROPAGATE;
        const [, , sx, sy] = this._local(e);
        const dx = sx - p.sx, dy = sy - p.sy;
        if (!p.moved) {
            if (Math.hypot(dx, dy) < DRAG_THRESHOLD)
                return Clutter.EVENT_STOP;
            p.moved = true;
            if (p.mode === 'click') {
                if (this.manager.locked)
                    return Clutter.EVENT_STOP;
                p.mode = 'move';
                this.add_style_pseudo_class('dragging');
                this.ease({scale_x: 1.02, scale_y: 1.02, duration: 120});
                this.set_pivot_point(0.5, 0.5);
            }
        }
        if (p.mode === 'move') {
            const r = this.manager.snapMove(this, {x: p.x0 + dx, y: p.y0 + dy, w: p.w0, h: p.h0});
            this.set_position(Math.round(r.x), Math.round(r.y));
        } else if (p.mode === 'resize') {
            const [mw, mh] = this.WidgetClass.minSize;
            const r = this.manager.snapResize(this, {
                x: p.x0, y: p.y0,
                w: Math.max(mw, p.w0 + dx),
                h: Math.max(mh, p.h0 + dy),
            });
            this.set_size(Math.round(Math.max(mw, r.w)), Math.round(Math.max(mh, r.h)));
            this._relayout();
        }
        return Clutter.EVENT_STOP;
    }

    _onRelease(e) {
        const p = this._press;
        if (!p || e.get_button() !== Clutter.BUTTON_PRIMARY)
            return Clutter.EVENT_PROPAGATE;
        this._press = null;
        this._grab?.dismiss();
        this._grab = null;
        this.remove_style_pseudo_class('dragging');
        this.ease({scale_x: 1, scale_y: 1, duration: 120});
        if (p.moved && (p.mode === 'move' || p.mode === 'resize')) {
            this.model.x = Math.round(this.x);
            this.model.y = Math.round(this.y);
            this.model.w = Math.round(this.width);
            this.model.h = Math.round(this.height);
            this.manager.save();
        } else if (!p.moved) {
            try {
                if (this.widget.click(p.lx, p.ly, this.width, this.height))
                    this.repaint();
            } catch (err) {
                console.error(`gnomlets: ${this.model.type} click: ${err.message}`);
            }
        }
        this._updateGrip();
        return Clutter.EVENT_STOP;
    }

    _onScroll(e) {
        if (!this.WidgetClass.scrollable)
            return Clutter.EVENT_PROPAGATE;
        let dir = e.get_scroll_direction();
        if (dir === Clutter.ScrollDirection.SMOOTH) {
            const [, dy] = e.get_scroll_delta();
            this._scrollAcc = (this._scrollAcc ?? 0) + dy;
            if (Math.abs(this._scrollAcc) < 1)
                return Clutter.EVENT_STOP;
            dir = this._scrollAcc > 0 ? Clutter.ScrollDirection.DOWN : Clutter.ScrollDirection.UP;
            this._scrollAcc = 0;
        }
        if (this.widget.scroll(dir)) {
            this.repaint();
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    }

    _onDestroy() {
        this._grab?.dismiss();
        this._grab = null;
        try {
            this.widget.disable();
        } catch (e) {
            console.error(`gnomlets: ${this.model.type} disable: ${e.message}`);
        }
    }
});
