import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';

import {Gnomlet} from './base.js';
import * as D from '../lib/draw.js';

export const NOTE_COLORS = {
    theme: {name: 'Theme', bg: null},
    yellow: {name: 'Yellow', bg: [1.0, 0.92, 0.55, 0.97], fg: [0.2, 0.17, 0.05, 1]},
    green: {name: 'Green', bg: [0.75, 0.93, 0.72, 0.97], fg: [0.08, 0.2, 0.08, 1]},
    blue: {name: 'Blue', bg: [0.73, 0.86, 1.0, 0.97], fg: [0.05, 0.12, 0.25, 1]},
    pink: {name: 'Pink', bg: [1.0, 0.78, 0.86, 0.97], fg: [0.28, 0.06, 0.13, 1]},
    purple: {name: 'Purple', bg: [0.86, 0.79, 1.0, 0.97], fg: [0.17, 0.08, 0.3, 1]},
};

const NoteDialog = GObject.registerClass(
class NoteDialog extends ModalDialog.ModalDialog {
    _init(text, onSave) {
        super._init({styleClass: 'gnomlets-note-dialog'});
        const title = new St.Label({text: 'Edit note', style: 'font-weight: bold; font-size: 1.2em; padding-bottom: 8px;'});
        this.contentLayout.add_child(title);
        this._entry = new St.Entry({
            style: 'min-width: 420px; min-height: 180px;',
            can_focus: true,
            x_expand: true,
        });
        const ct = this._entry.clutter_text;
        ct.set_single_line_mode(false);
        ct.set_activatable(false);
        ct.set_line_wrap(true);
        ct.set_line_wrap_mode(2 /* WORD_CHAR */);
        ct.set_text(text);
        this.contentLayout.add_child(this._entry);
        this.contentLayout.add_child(new St.Label({
            text: 'Ctrl+Enter to save',
            style: 'font-size: 0.85em; opacity: 0.6; padding-top: 6px;',
        }));
        ct.connect('key-press-event', (_a, e) => {
            const sym = e.get_key_symbol();
            if ((sym === Clutter.KEY_Return || sym === Clutter.KEY_KP_Enter) &&
                (e.get_state() & Clutter.ModifierType.CONTROL_MASK)) {
                this._save(onSave);
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });
        this.setButtons([
            {label: 'Cancel', action: () => this.close(), key: Clutter.KEY_Escape},
            {label: 'Save', action: () => this._save(onSave), default: true},
        ]);
        this.setInitialKeyFocus(ct);
    }

    _save(onSave) {
        onSave(this._entry.get_text());
        this.close();
    }
});

export class NoteWidget extends Gnomlet {
    static type = 'note';
    static defaults = {text: 'Double-click to write a note.', color: 'yellow'};

    enable() {
        this._lastClick = 0;
        this._applyColor();
    }

    optsChanged() {
        this._applyColor();
    }

    _applyColor() {
        const c = NOTE_COLORS[this.opts.color];
        this.host.setCardOverride(c?.bg ? {bg: c.bg, fg: c.fg} : null);
    }

    edit() {
        const dlg = new NoteDialog(this.opts.text ?? '', text => this.setOpt('text', text));
        dlg.open();
    }

    click() {
        const now = Date.now();
        if (now - this._lastClick < 400) {
            this._lastClick = 0;
            this.edit();
            return true;
        }
        this._lastClick = now;
        return false;
    }

    buildMenu(m) {
        m.action('Edit…', () => this.edit());
        m.submenu('Color', sub => {
            for (const [id, c] of Object.entries(NOTE_COLORS))
                sub.radio(c.name, this.opts.color === id, () => this.setOpt('color', id));
        });
    }

    draw(cr, w, h, t) {
        const c = NOTE_COLORS[this.opts.color];
        const fg = c?.fg ?? t.fg;
        const pad = Math.max(12, Math.min(w, h) * 0.09);
        const text = this.opts.text ?? '';
        // pick the largest size that fits, between 11 and 26 px
        let size = 26;
        for (; size > 11; size -= 1) {
            const m = D.measure(cr, text, {size, maxWidth: w - pad * 2, wrap: true, theme: t});
            if (m.height <= h - pad * 2)
                break;
        }
        D.text(cr, text, pad, pad, {
            size, color: fg, maxWidth: w - pad * 2, maxHeight: h - pad * 2, wrap: true,
            weight: D.Weight.MEDIUM, theme: t,
        });
    }
}
