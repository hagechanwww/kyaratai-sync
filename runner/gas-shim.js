// gas/sync.gs を GAS ではなく Node.js（GitHub Actions など）で動かすための「GASの代わり」。
//
// ★なぜ要るか（2026-10-06に判明）: GoogleのサーバーからDiscordへ「Bot」として通信すると、
//   Discordの入口（Cloudflare）で 403「internal network error」(40333) として止められる。
//   GASは送信元も User-Agent も変えられないので回避できない。sync.gs の中身はそのまま使い、
//   GASの部品（UrlFetchApp / PropertiesService など）だけをここで置き換える。
//
// - 通信は curl を同期で呼ぶ（sync.gs は同期で書かれているため、await に書き換えずに済む）
// - 進み具合（スクリプトプロパティの代わり）は JSON ファイルに保存する。トークンは保存しない
// - トークンは環境変数から読む（GitHub Actions なら Secrets）
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const SECRET_KEYS = ['DISCORD_BOT_TOKEN', 'NOTION_TOKEN', 'NOTION_URL', 'NOTION_DATABASE', 'DISCORD_GUILD_ID'];
const USER_AGENT = 'DiscordBot (https://github.com/hagechanwww, 1.0)';

function makeBlob(buffer, contentType, name) {
  return {
    _buf: buffer, _type: contentType || 'application/octet-stream', _name: name || 'file',
    getBytes() { return this._buf; },
    getContentType() { return this._type; },
    setContentType(t) { this._type = t; return this; },
    getName() { return this._name; },
    setName(n) { this._name = n; return this; },
    isBlob: true,
  };
}

/** テスト用: 本物のURLをローカルの偽サーバーへ向け直す（環境変数 GAS_SHIM_REWRITE に JSON で渡す） */
function rewriteUrl(url) {
  const map = process.env.GAS_SHIM_REWRITE ? JSON.parse(process.env.GAS_SHIM_REWRITE) : null;
  if (!map) return url;
  for (const from of Object.keys(map)) if (url.indexOf(from) === 0) return map[from] + url.slice(from.length);
  return url;
}

function parseHeaders(text) {
  // -L でリダイレクトをたどると複数のレスポンスヘッダーが並ぶので、最後の塊を使う
  const blocks = text.split(/\r?\n\r?\n/).filter((b) => /^HTTP\//.test(b.trim()));
  const last = blocks.length ? blocks[blocks.length - 1] : '';
  const headers = {};
  last.split(/\r?\n/).slice(1).forEach((line) => {
    const i = line.indexOf(':');
    if (i > 0) headers[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  });
  return headers;
}

function fetchSync(url, opts) {
  opts = opts || {};
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gasfetch-'));
  try {
    const bodyFile = path.join(dir, 'body');
    const headerFile = path.join(dir, 'headers');
    const method = (opts.method || 'get').toUpperCase();
    const args = ['-sS', '-L', '--max-time', '120', '-X', method, '-o', bodyFile, '-D', headerFile, '-w', '%{http_code}'];
    const headers = Object.assign({}, opts.headers || {});
    if (!Object.keys(headers).some((k) => k.toLowerCase() === 'user-agent')) headers['User-Agent'] = USER_AGENT;
    const payload = opts.payload;
    if (typeof payload === 'string') {
      const f = path.join(dir, 'payload');
      fs.writeFileSync(f, payload);
      args.push('--data-binary', '@' + f);
      headers['Content-Type'] = opts.contentType || 'application/x-www-form-urlencoded';
    } else if (payload && typeof payload === 'object') {
      // Blob を含む payload は GAS と同じく multipart/form-data で送る
      let n = 0;
      for (const key of Object.keys(payload)) {
        const v = payload[key];
        if (v && v.isBlob) {
          const f = path.join(dir, 'part' + (n++));
          fs.writeFileSync(f, v.getBytes());
          const name = String(v.getName() || 'file').replace(/[";]/g, '_');
          args.push('-F', key + '=@' + f + ';type=' + v.getContentType() + ';filename="' + name + '"');
        } else {
          args.push('--form-string', key + '=' + String(v));
        }
      }
    }
    Object.keys(headers).forEach((k) => args.push('-H', k + ': ' + headers[k]));
    args.push(rewriteUrl(url));
    let code;
    try {
      code = Number(execFileSync('curl', args, { encoding: 'utf8', maxBuffer: 1024 * 1024 }).trim());
    } catch (e) {
      throw new Error('通信に失敗しました（' + url.split('?')[0] + '）: ' + String(e.stderr || e.message).trim());
    }
    const body = fs.existsSync(bodyFile) ? fs.readFileSync(bodyFile) : Buffer.alloc(0);
    const resHeaders = fs.existsSync(headerFile) ? parseHeaders(fs.readFileSync(headerFile, 'utf8')) : {};
    if (code >= 400 && opts.muteHttpExceptions === false) throw new Error('HTTP ' + code + ': ' + url);
    const ct = Object.keys(resHeaders).filter((k) => k.toLowerCase() === 'content-type').map((k) => resHeaders[k])[0];
    return {
      getResponseCode: () => code,
      getContentText: () => body.toString('utf8'),
      getHeaders: () => resHeaders,
      getBlob: () => makeBlob(body, ct ? ct.split(';')[0].trim() : undefined, path.basename(url.split('?')[0])),
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** 進み具合を JSON ファイルに置く。トークン類は環境変数から読み、ファイルには書かない。 */
function makeProperties(stateFile, env) {
  let state = {};
  if (fs.existsSync(stateFile)) state = JSON.parse(fs.readFileSync(stateFile, 'utf8') || '{}');
  const secrets = {};
  SECRET_KEYS.forEach((k) => { if (env[k]) secrets[k] = String(env[k]).trim(); });
  const save = () => {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    const sorted = {};
    Object.keys(state).sort().forEach((k) => { sorted[k] = state[k]; });
    fs.writeFileSync(stateFile, JSON.stringify(sorted, null, 1) + '\n');
  };
  return {
    getProperties: () => Object.assign({}, state, secrets),
    setProperty: (k, v) => {
      if (SECRET_KEYS.indexOf(k) >= 0) throw new Error(k + ' はファイルに保存しません');
      state[k] = String(v);
      save();
    },
    deleteProperty: (k) => { delete state[k]; save(); },
  };
}

function formatDate(date, tz, fmt) {
  const p = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(date).reduce((o, x) => { o[x.type] = x.value; return o; }, {});
  if (p.hour === '24') p.hour = '00';
  return fmt.replace('yyyy', p.year).replace('MM', p.month).replace('dd', p.day)
    .replace('HH', p.hour).replace('mm', p.minute).replace('ss', p.second);
}

function sleepSync(ms) {
  if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** sync.gs を読み込める入れ物を作る */
function createSandbox(opts) {
  const props = makeProperties(opts.stateFile, opts.env || process.env);
  const noopTrigger = { timeBased: () => noopTrigger, everyMinutes: () => noopTrigger, create: () => noopTrigger };
  return {
    console,
    Logger: { log: (s) => console.log(String(s)) },
    UrlFetchApp: { fetch: fetchSync },
    PropertiesService: { getScriptProperties: () => props },
    LockService: { getScriptLock: () => ({ tryLock: () => true, waitLock: () => {}, releaseLock: () => {} }) },
    // 定期実行は GitHub Actions のスケジュールが受け持つので、トリガー関係は何もしない
    ScriptApp: { newTrigger: () => noopTrigger, getProjectTriggers: () => [], deleteTrigger: () => {} },
    Utilities: { sleep: sleepSync, formatDate: formatDate },
  };
}

module.exports = { createSandbox, fetchSync, makeProperties, formatDate, SECRET_KEYS };
