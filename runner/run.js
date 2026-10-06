#!/usr/bin/env node
// gas/sync.gs を Node.js で1回動かす。GitHub Actions から呼ばれる（自分のPCでも動く）。
//
//   node runner/run.js checkSetup     接続と「チャンネル → Notionページ」の対応を確認（何も書き込まない）
//   node runner/run.js sync           新しい投稿を転記する（定期実行はこれ）
//   node runner/run.js rescanCovers   サムネを選び直す
//
// トークンは環境変数 DISCORD_BOT_TOKEN / NOTION_TOKEN / NOTION_URL から読む。
// 進み具合は STATE_FILE（既定: リポジトリ直下の state/state.json）に保存する。
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createSandbox } = require('./gas-shim');

const TASKS = ['checkSetup', 'sync', 'rescanCovers'];
const task = process.argv[2] || 'sync';
if (TASKS.indexOf(task) < 0) {
  console.error('使い方: node runner/run.js ' + TASKS.join(' | '));
  process.exit(2);
}

const root = path.resolve(__dirname, '..');
const codeFile = process.env.SYNC_CODE || [path.join(root, 'sync.gs'), path.join(root, 'gas', 'sync.gs')].filter(fs.existsSync)[0];
const stateFile = process.env.STATE_FILE || path.join(root, 'state', 'state.json');

const sandbox = createSandbox({ stateFile: stateFile, env: process.env });
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(codeFile, 'utf8'), sandbox, { filename: path.basename(codeFile) });
if (process.env.SYNC_CONFIG) vm.runInContext(process.env.SYNC_CONFIG, sandbox); // 例: "CONFIG.COVER_RULE = 'first';"

try {
  sandbox[task]();
} catch (e) {
  console.error('★' + e.message);
  process.exitCode = 1;
}
