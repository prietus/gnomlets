import {DigitalClock, AnalogClock} from './clock.js';
import {CalendarWidget} from './calendar.js';
import {WeatherWidget} from './weather.js';
import {SystemWidget, NetworkWidget, DisksWidget, ProcessesWidget, BatteryWidget} from './monitors.js';
import {MediaWidget} from './media.js';
import {NoteWidget} from './note.js';
import {CATALOG_BY_TYPE} from '../lib/catalog.js';

/** Every widget type, in the order the gallery shows them. */
export const WIDGETS = [
    DigitalClock,
    AnalogClock,
    CalendarWidget,
    WeatherWidget,
    MediaWidget,
    SystemWidget,
    NetworkWidget,
    DisksWidget,
    ProcessesWidget,
    BatteryWidget,
    NoteWidget,
];

for (const W of WIDGETS)
    Object.assign(W, CATALOG_BY_TYPE[W.type]);

export const BY_TYPE = Object.fromEntries(WIDGETS.map(W => [W.type, W]));
