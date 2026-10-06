/**
 * キャラ対転記のタイマー（Google Apps Script）
 *
 * 5分ごとに GitHub Actions の「キャラ対転記」ワークフローを起動するだけのスクリプト。
 * 転記そのものは GitHub Actions 側で動く（GAS から Discord へは通信が止められるため、ここは合図を送るだけ）。
 * GitHub 自身の定期実行は遅れたり飛ばされたりしやすいので、起動の合図は GAS の時間トリガーに任せる。
 *
 * 準備:
 *   1. GitHub で「Fine-grained personal access token」を作る
 *      （対象リポジトリは kyaratai-sync だけ、権限は Actions の Read and write だけ）
 *   2. このプロジェクトの「プロジェクトの設定」→「スクリプト プロパティ」に GITHUB_TOKEN として入れる
 *   3. startTimer を実行（初回は「権限を確認」→ 許可）
 *
 * 止める: stopTimer を実行。GitHub の変数 SYNC_ENABLED を false にしても、起動された側が何もせずに終わる。
 * トークンの期限が切れると kick が失敗して Google からエラーのメールが来る → トークンを作り直して入れ替える。
 */

const TIMER = {
  REPO: 'hagechanwww/kyaratai-sync',
  WORKFLOW: 'sync.yml',
  BRANCH: 'main',
  MINUTES: 5,
};

/** タイマーを入れて、1回目の合図をすぐ送る。 */
function startTimer() {
  const repo = github_('get', '');
  if (repo.private) {
    Logger.log('★リポジトリが非公開です。タイマーの合図は公開リポジトリのときだけ転記につながります'
      + '（非公開だと5分ごとは無料枠に収まらないため）。非公開のままなら30分ごとの定期実行だけで動きます。');
  }
  github_('get', '/actions/workflows/' + TIMER.WORKFLOW);
  removeTimers_();
  ScriptApp.newTrigger('kick').timeBased().everyMinutes(TIMER.MINUTES).create();
  kick();
  Logger.log(TIMER.MINUTES + '分ごとのタイマーを入れて、1回目の合図を送りました。'
    + 'GitHub の「Actions」に「キャラ対転記」の実行が出ていれば成功です。');
}

/** タイマーを止める。 */
function stopTimer() {
  const n = removeTimers_();
  Logger.log(n ? 'タイマーを止めました。' : 'タイマーは動いていませんでした。');
}

/** ワークフローを1回起動する（時間トリガーから呼ばれる）。 */
function kick() {
  try {
    github_('post', '/actions/workflows/' + TIMER.WORKFLOW + '/dispatches',
      { ref: TIMER.BRANCH, inputs: { task: 'sync', timer: 'true' } });
  } catch (e) {
    // GitHub が一時的に混んでいるだけなら、次の回にまた送るのでエラーのメールは出さない
    if (e.transient) { Logger.log(e.message); return; }
    throw e;
  }
}

function removeTimers_() {
  let n = 0;
  ScriptApp.getProjectTriggers().forEach((t) => {
    if (t.getHandlerFunction() === 'kick') { ScriptApp.deleteTrigger(t); n++; }
  });
  return n;
}

function github_(method, path, body) {
  const token = (PropertiesService.getScriptProperties().getProperty('GITHUB_TOKEN') || '').trim();
  if (!token) throw new Error('★スクリプト プロパティに GITHUB_TOKEN がありません（「プロジェクトの設定」→「スクリプト プロパティ」）');
  let res;
  try {
    const opts = {
      method: method,
      headers: { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json' },
      muteHttpExceptions: true,
    };
    if (body) { opts.contentType = 'application/json'; opts.payload = JSON.stringify(body); }
    res = UrlFetchApp.fetch('https://api.github.com/repos/' + TIMER.REPO + path, opts);
  } catch (e) {
    throw transient_('GitHub に届きませんでした（次の回にまた送ります）: ' + e.message);
  }
  const code = res.getResponseCode();
  const text = res.getContentText();
  if (code >= 200 && code < 300) return text ? JSON.parse(text) : null;
  let msg = '';
  try { msg = JSON.parse(text).message || ''; } catch (e) { msg = text.slice(0, 200); }
  if (code === 401) {
    throw new Error('★GitHubのトークンが違うか、期限が切れています。トークンを作り直して GITHUB_TOKEN を入れ替えてください');
  }
  if ((code === 403 && /rate limit/i.test(msg)) || code === 429 || code >= 500) {
    throw transient_('GitHub が混んでいます（次の回にまた送ります）: ' + code + ' ' + msg);
  }
  if (code === 403) {
    throw new Error('★トークンに権限がありません。「Repository permissions」の「Actions」を「Read and write」にしてください（' + msg + '）');
  }
  if (code === 404) {
    throw new Error('★' + TIMER.REPO + ' か ' + TIMER.WORKFLOW + ' が見つかりません。'
      + 'トークンの「Repository access」で kyaratai-sync を選んだか確認してください');
  }
  throw new Error('★GitHub ' + code + ': ' + msg);
}

function transient_(message) {
  const e = new Error(message);
  e.transient = true;
  return e;
}
