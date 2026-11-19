// English date names, so every widget formats dates the same way.
export const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
export const DAYS_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export const DAYS_INITIAL = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
export const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
    'August', 'September', 'October', 'November', 'December'];
export const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export const cap = s => s.charAt(0).toUpperCase() + s.slice(1);

/** "Wednesday, November 18" from a JS Date or a GLib.DateTime. */
export function longDate(d) {
    const [wd, day, mon] = parts(d);
    return `${DAYS[wd]}, ${MONTHS[mon]} ${day}`;
}

/** "Wed, Nov 18" */
export function shortDate(d) {
    const [wd, day, mon] = parts(d);
    return `${DAYS_SHORT[wd]}, ${MONTHS_SHORT[mon]} ${day}`;
}

function parts(d) {
    if (d instanceof Date)
        return [d.getDay(), d.getDate(), d.getMonth()];
    // GLib.DateTime: day of week 1 = Monday … 7 = Sunday
    return [d.get_day_of_week() % 7, d.get_day_of_month(), d.get_month() - 1];
}

export function hhmm(d, h24 = true) {
    const h = d.getHours(), m = String(d.getMinutes()).padStart(2, '0');
    if (h24)
        return `${String(h).padStart(2, '0')}:${m}`;
    return `${h % 12 || 12}:${m} ${h < 12 ? 'AM' : 'PM'}`;
}
