import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

let _session = null;

function session() {
    _session ??= new Soup.Session({user_agent: 'gnomlets/1.0', timeout: 20});
    return _session;
}

const decoder = new TextDecoder();

/** GETs a URL and parses the JSON answer. */
export function getJSON(url, cancellable = null) {
    return new Promise((resolve, reject) => {
        const msg = Soup.Message.new('GET', url);
        if (!msg) {
            reject(new Error(`bad URL ${url}`));
            return;
        }
        session().send_and_read_async(msg, GLib.PRIORITY_DEFAULT, cancellable, (s, res) => {
            try {
                const bytes = s.send_and_read_finish(res);
                const status = msg.get_status();
                if (status !== Soup.Status.OK)
                    throw new Error(`HTTP ${status}`);
                resolve(JSON.parse(decoder.decode(bytes.get_data())));
            } catch (e) {
                reject(e);
            }
        });
    });
}

/** Downloads a URL into a file; resolves with the path. */
export function download(url, path, cancellable = null) {
    return new Promise((resolve, reject) => {
        const msg = Soup.Message.new('GET', url);
        if (!msg) {
            reject(new Error(`bad URL ${url}`));
            return;
        }
        session().send_and_read_async(msg, GLib.PRIORITY_DEFAULT, cancellable, (s, res) => {
            try {
                const bytes = s.send_and_read_finish(res);
                if (msg.get_status() !== Soup.Status.OK)
                    throw new Error(`HTTP ${msg.get_status()}`);
                GLib.file_set_contents(path, bytes.get_data());
                resolve(path);
            } catch (e) {
                reject(e);
            }
        });
    });
}

export function destroySession() {
    _session?.abort();
    _session = null;
}
