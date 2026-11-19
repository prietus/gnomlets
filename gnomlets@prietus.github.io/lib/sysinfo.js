// Samplers of /proc and /sys shared by every widget that needs them. Each one
// polls only while somebody is subscribed.
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

const decoder = new TextDecoder();

export function readFile(path) {
    try {
        const [ok, bytes] = GLib.file_get_contents(path);
        return ok ? decoder.decode(bytes) : null;
    } catch {
        return null;
    }
}

const HISTORY = 60;

class Poller {
    constructor(interval) {
        this._interval = interval;
        this._subs = new Set();
        this._timer = 0;
    }

    subscribe(cb) {
        this._subs.add(cb);
        if (!this._timer) {
            this.poll();
            this._timer = GLib.timeout_add(GLib.PRIORITY_LOW, this._interval, () => {
                this.poll();
                return GLib.SOURCE_CONTINUE;
            });
        } else {
            cb(this);
        }
        return () => {
            this._subs.delete(cb);
            if (this._subs.size === 0 && this._timer) {
                GLib.source_remove(this._timer);
                this._timer = 0;
                this.reset?.();
            }
        };
    }

    poll() {
        try {
            this.sample();
        } catch (e) {
            console.warn(`gnomlets: ${this.constructor.name}: ${e.message}`);
        }
        for (const cb of this._subs)
            cb(this);
    }

    destroy() {
        if (this._timer)
            GLib.source_remove(this._timer);
        this._timer = 0;
        this._subs.clear();
    }
}

// --- CPU, memory, network, temperature --------------------------------------

class SystemSampler extends Poller {
    constructor() {
        super(1000);
        this.reset();
    }

    reset() {
        this.cpu = 0;
        this.cores = [];
        this.cpuHistory = [];
        this.mem = {total: 0, used: 0, frac: 0, swapTotal: 0, swapUsed: 0};
        this.memHistory = [];
        this.rx = 0;
        this.tx = 0;
        this.rxHistory = [];
        this.txHistory = [];
        this.iface = '';
        this.rxTotal = 0;
        this.txTotal = 0;
        this.temp = null;
        this.load = [0, 0, 0];
        this.uptime = 0;
        this._prevCpu = null;
        this._prevNet = null;
    }

    sample() {
        this._sampleCpu();
        this._sampleMem();
        this._sampleNet();
        this._sampleTemp();
        const load = readFile('/proc/loadavg');
        if (load)
            this.load = load.split(' ').slice(0, 3).map(Number);
        const up = readFile('/proc/uptime');
        if (up)
            this.uptime = parseFloat(up);
    }

    _sampleCpu() {
        const stat = readFile('/proc/stat');
        if (!stat)
            return;
        const rows = stat.split('\n').filter(l => l.startsWith('cpu'));
        const parsed = rows.map(l => {
            const f = l.trim().split(/\s+/).slice(1).map(Number);
            const idle = f[3] + (f[4] || 0);
            const total = f.reduce((a, b) => a + b, 0);
            return {idle, total};
        });
        if (this._prevCpu) {
            const frac = (cur, prev) => {
                const dt = cur.total - prev.total;
                return dt > 0 ? 1 - (cur.idle - prev.idle) / dt : 0;
            };
            this.cpu = frac(parsed[0], this._prevCpu[0]);
            this.cores = parsed.slice(1).map((c, i) => frac(c, this._prevCpu[i + 1] ?? c));
            push(this.cpuHistory, this.cpu);
        }
        this.cpuTotalJiffies = parsed[0].total;
        this.ncpu = parsed.length - 1;
        this._prevCpu = parsed;
    }

    _sampleMem() {
        const info = readFile('/proc/meminfo');
        if (!info)
            return;
        const kv = {};
        for (const line of info.split('\n')) {
            const m = line.match(/^(\w+):\s+(\d+)/);
            if (m)
                kv[m[1]] = Number(m[2]) * 1024;
        }
        const total = kv.MemTotal || 1;
        const avail = kv.MemAvailable ?? kv.MemFree ?? 0;
        this.mem = {
            total,
            used: total - avail,
            frac: (total - avail) / total,
            swapTotal: kv.SwapTotal || 0,
            swapUsed: (kv.SwapTotal || 0) - (kv.SwapFree || 0),
        };
        push(this.memHistory, this.mem.frac);
    }

    _sampleNet() {
        const dev = readFile('/proc/net/dev');
        if (!dev)
            return;
        let rx = 0, tx = 0, best = '', bestBytes = -1;
        for (const line of dev.split('\n').slice(2)) {
            const m = line.match(/^\s*([^:]+):\s*(.*)$/);
            if (!m)
                continue;
            const name = m[1].trim();
            if (name === 'lo' || /^(veth|docker|br-|virbr|vnet|tun|tap)/.test(name))
                continue;
            const f = m[2].trim().split(/\s+/).map(Number);
            rx += f[0];
            tx += f[8];
            if (f[0] + f[8] > bestBytes) {
                bestBytes = f[0] + f[8];
                best = name;
            }
        }
        const now = GLib.get_monotonic_time() / 1e6;
        if (this._prevNet) {
            const dt = Math.max(0.001, now - this._prevNet.t);
            this.rx = Math.max(0, (rx - this._prevNet.rx) / dt);
            this.tx = Math.max(0, (tx - this._prevNet.tx) / dt);
            push(this.rxHistory, this.rx);
            push(this.txHistory, this.tx);
        }
        this.rxTotal = rx;
        this.txTotal = tx;
        this.iface = best;
        this._prevNet = {rx, tx, t: now};
    }

    _sampleTemp() {
        let max = null;
        const scan = (dir, re) => {
            let d;
            try {
                d = GLib.Dir.open(dir, 0);
            } catch {
                return [];
            }
            const names = [];
            let n;
            while ((n = d.read_name()) !== null) {
                if (re.test(n))
                    names.push(n);
            }
            d.close();
            return names;
        };
        if (!this._tempPaths) {
            this._tempPaths = [];
            for (const z of scan('/sys/class/thermal', /^thermal_zone\d+$/))
                this._tempPaths.push(`/sys/class/thermal/${z}/temp`);
            if (this._tempPaths.length === 0) {
                for (const h of scan('/sys/class/hwmon', /^hwmon\d+$/)) {
                    for (const t of scan(`/sys/class/hwmon/${h}`, /^temp\d+_input$/))
                        this._tempPaths.push(`/sys/class/hwmon/${h}/${t}`);
                }
            }
        }
        for (const p of this._tempPaths) {
            const v = parseInt(readFile(p));
            if (Number.isFinite(v) && v > 0 && v < 150000)
                max = Math.max(max ?? 0, v / 1000);
        }
        this.temp = max;
    }
}

function push(arr, v) {
    arr.push(v);
    if (arr.length > HISTORY)
        arr.shift();
}

// --- processes ----------------------------------------------------------------

let _pageSize = 0;
/**
 * The kernel page size (4 KiB on most PCs, 16 KiB on Apple silicon), worked
 * out from our own resident size, which /proc gives both in pages and in KiB.
 */
function pageSize() {
    if (!_pageSize) {
        _pageSize = 4096;
        const pages = Number(readFile('/proc/self/statm')?.split(' ')[1]);
        const kib = Number(readFile('/proc/self/status')?.match(/^VmRSS:\s+(\d+)/m)?.[1]);
        if (pages > 0 && kib > 0) {
            const guess = (kib * 1024) / pages;
            _pageSize = [4096, 16384, 65536].reduce((a, b) =>
                Math.abs(Math.log2(b / guess)) < Math.abs(Math.log2(a / guess)) ? b : a);
        }
    }
    return _pageSize;
}

class ProcessSampler extends Poller {
    constructor() {
        super(2000);
        this.reset();
    }

    reset() {
        this.list = [];
        this._prev = new Map();
        this._prevTotal = 0;
    }

    sample() {
        const stat = readFile('/proc/stat');
        const first = stat?.split('\n')[0] ?? '';
        const f = first.trim().split(/\s+/).slice(1).map(Number);
        const total = f.reduce((a, b) => a + b, 0);
        const ncpu = (stat?.match(/^cpu\d+/gm) ?? []).length || 1;
        const dTotal = this._prevTotal ? total - this._prevTotal : 0;
        const ps = pageSize();
        const cur = new Map();
        const list = [];
        const dir = GLib.Dir.open('/proc', 0);
        let name;
        while ((name = dir.read_name()) !== null) {
            if (!/^\d+$/.test(name))
                continue;
            const s = readFile(`/proc/${name}/stat`);
            if (!s)
                continue;
            const open = s.indexOf('(');
            const close = s.lastIndexOf(')');
            const comm = s.slice(open + 1, close);
            const rest = s.slice(close + 2).split(' ');
            // rest[0] is field 3 (state); utime is field 14, stime 15, rss 24
            const ticks = Number(rest[11]) + Number(rest[12]);
            const rss = Number(rest[21]) * ps;
            cur.set(name, ticks);
            const prev = this._prev.get(name);
            const cpu = prev !== undefined && dTotal > 0 ? ((ticks - prev) / dTotal) * ncpu : 0;
            if (rss > 0 || cpu > 0)
                list.push({pid: Number(name), name: comm, cpu, rss});
        }
        dir.close();
        list.sort((a, b) => b.cpu - a.cpu || b.rss - a.rss);
        this.list = list;
        this._prev = cur;
        this._prevTotal = total;
    }
}

// --- disks --------------------------------------------------------------------

class DiskSampler extends Poller {
    constructor() {
        super(30000);
        this.disks = [];
        this._running = false;
    }

    sample() {
        if (this._running)
            return;
        this._running = true;
        const proc = Gio.Subprocess.new(
            ['df', '-B1', '--output=source,fstype,size,used,avail,target',
                '-x', 'tmpfs', '-x', 'devtmpfs', '-x', 'efivarfs', '-x', 'overlay',
                '-x', 'squashfs', '-x', 'ramfs', '-x', 'fuse.portal', '-x', 'fuse.gvfsd-fuse'],
            Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
        proc.communicate_utf8_async(null, null, (p, res) => {
            this._running = false;
            try {
                const [, out] = p.communicate_utf8_finish(res);
                const seen = new Set();
                const disks = [];
                for (const line of out.split('\n').slice(1)) {
                    const f = line.trim().split(/\s+/);
                    if (f.length < 6)
                        continue;
                    const [source, fstype, size, used, avail] = f;
                    const target = f.slice(5).join(' ');
                    if (seen.has(source) || Number(size) === 0)
                        continue;
                    if (target.startsWith('/boot') || target.startsWith('/run') ||
                        target.startsWith('/var/lib/') || target.startsWith('/snap'))
                        continue;
                    seen.add(source);
                    disks.push({
                        source, fstype, target,
                        size: Number(size), used: Number(used), avail: Number(avail),
                    });
                }
                disks.sort((a, b) => (a.target === '/' ? -1 : b.target === '/' ? 1 : a.target.localeCompare(b.target)));
                this.disks = disks;
                for (const cb of this._subs)
                    cb(this);
            } catch (e) {
                console.warn(`gnomlets: df: ${e.message}`);
            }
        });
    }
}

// --- battery ------------------------------------------------------------------

class BatterySampler extends Poller {
    constructor() {
        super(10000);
        this.batteries = [];
        this.ac = null;
    }

    sample() {
        const base = '/sys/class/power_supply';
        const batteries = [];
        let ac = null;
        let d;
        try {
            d = GLib.Dir.open(base, 0);
        } catch {
            this.batteries = [];
            return;
        }
        let n;
        while ((n = d.read_name()) !== null) {
            const type = readFile(`${base}/${n}/type`)?.trim();
            if (type === 'Mains' || type === 'USB') {
                if (readFile(`${base}/${n}/online`)?.trim() === '1')
                    ac = true;
                else if (ac === null)
                    ac = false;
            }
            if (type !== 'Battery')
                continue;
            if (readFile(`${base}/${n}/scope`)?.trim() === 'Device')
                continue;
            const num = f => {
                const v = parseFloat(readFile(`${base}/${n}/${f}`));
                return Number.isFinite(v) ? v : null;
            };
            const status = readFile(`${base}/${n}/status`)?.trim() ?? 'Unknown';
            const capacity = num('capacity');
            const energyNow = num('energy_now') ?? num('charge_now');
            const energyFull = num('energy_full') ?? num('charge_full');
            const power = num('power_now') ?? num('current_now');
            let hours = null;
            if (power && power > 0 && energyNow !== null) {
                if (status === 'Discharging')
                    hours = energyNow / power;
                else if (status === 'Charging' && energyFull !== null)
                    hours = (energyFull - energyNow) / power;
            }
            const model = readFile(`${base}/${n}/model_name`)?.trim();
            batteries.push({
                name: model || n,
                capacity: capacity ?? (energyNow !== null && energyFull ? (100 * energyNow) / energyFull : 0),
                status,
                hours,
                watts: readFile(`${base}/${n}/power_now`) ? (power ?? 0) / 1e6 : null,
            });
        }
        d.close();
        this.batteries = batteries;
        this.ac = ac;
    }
}

// Singletons, created lazily and destroyed when the extension is disabled.
let _system, _processes, _disks, _battery;

export const system = () => (_system ??= new SystemSampler());
export const processes = () => (_processes ??= new ProcessSampler());
export const disks = () => (_disks ??= new DiskSampler());
export const battery = () => (_battery ??= new BatterySampler());

export function destroyAll() {
    for (const s of [_system, _processes, _disks, _battery])
        s?.destroy();
    _system = _processes = _disks = _battery = null;
}
