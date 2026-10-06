/**
 * ★2026-10-06: GoogleのサーバーからDiscordへBotとして通信すると、Discordの入口で 403（40333
 *   internal network error）として止められる。GASからは回避できないため、このファイルは
 *   runner/run.js（Node.js。GitHub Actions で定期実行）から読み込んで動かす。GASの部品は
 *   runner/gas-shim.js が代わりを務めるので、中身はGAS向けの書き方のまま。
 *
 * Discord の指定カテゴリ（既定「キャラ対」）の投稿を、Notion のデータベース（ギャラリー）の
 * 同じ名前のページへ自動で追記する。チャンネルで一番最初に貼られた画像は、そのページの
 * カバー画像（＝ギャラリーのサムネ）にする（CONFIG.COVER_RULE で「最初の画像」にも切り替えられる）。
 *
 * サムネは既定で「ピン留めした画像」（CONFIG.COVER_RULE）。
 *
 * 使い方（詳しくは references/setup.md）:
 *   1. スクリプトプロパティに DISCORD_BOT_TOKEN / NOTION_TOKEN / NOTION_URL を入れる
 *      NOTION_URL は既存のギャラリー（データベース）のリンクか、空のページのリンク。
 *      空のページなら、startSync のときにその中へ「キャラ対」ギャラリーを自動で作る
 *   2. checkSetup を実行 → ログで「チャンネル → Notionページ」の対応を確認（何も書き込まない）
 *   3. startSync を実行 → 5分ごとの自動転記が始まる（初回は過去の投稿もさかのぼって転記）
 *   止めるときは stopSync。最初の画像を消して差し替えたときは rescanCovers。
 *
 * ★設計メモ
 * - 進み具合（どの投稿まで転記したか）はチャンネルごとにスクリプトプロパティへ保存する。
 *   Notionへの追記が成功してから進めるので、途中で止まっても重複・抜けが出ない。
 * - GASは1回6分で強制終了されるため、4分半で切り上げて続きは次の回に回す。
 * - Discordの画像URLは約1日で失効するので、画像はNotionへアップロードして貼る（リンクにしない）。
 *   Notionの上限（無料プラン5MB）を超える画像は縮小版を取り直す。それでも無理ならDiscordへのリンク。
 * - 編集・削除はNotionへ反映しない（追記のみ）。
 */

const CONFIG = {
  // 転記するカテゴリの名前（Discord側）
  CATEGORY_NAME: 'キャラ対',
  // ボットが複数のサーバーに入っているときに選ぶサーバー名（DISCORD_GUILD_ID を入れればそちらが優先）
  GUILD_NAME: 'キャラ対',
  // チャンネル名とNotionのページ名が自動で結び付かないときだけ書く: { 'チャンネル名': 'ページ名' }
  CHANNEL_TO_PAGE: {},
  // 転記しないチャンネル名
  EXCLUDE_CHANNELS: [],
  // 同じ名前のページが無いとき、データベースに新しく作るか
  CREATE_MISSING_PAGES: true,
  // NOTION_URL が空のページのとき、その中に自動で作るギャラリーの名前
  GALLERY_TITLE: 'キャラ対',
  // スト6のキャラ名の読み替え（ディージェイ＝DJ、ザンギエフ＝ザンギ など。下の SF6_ALIASES）を使うか
  USE_SF6_ALIASES: true,
  // チャンネル内のスレッド（フォーラムの投稿を含む）も同じページに追記するか
  INCLUDE_THREADS: true,
  // ボットの投稿も転記するか
  INCLUDE_BOTS: false,
  // サムネ（ページのカバー）の決め方:
  //   'pinned' … チャンネルでピン留めした画像（複数あれば最後にピン留めしたもの）。過去の画像があるチャンネル向け
  //   'first'  … チャンネルで一番最初に貼られた画像
  //   'off'    … カバーを変えない
  // ピン留めが無いチャンネルは、今のカバーのまま変えない
  COVER_RULE: 'pinned',
  // Notionに上げられる1ファイルの上限（無料プラン5MB。有料プランなら20まで上げてよい）
  NOTION_FILE_LIMIT_MB: 5,
  // 自動転記の間隔（分）。1 / 5 / 10 / 15 / 30 のどれか
  TRIGGER_MINUTES: 5,
  // 1回の実行で使う時間（GASの上限6分に余裕を持たせる）
  TIME_BUDGET_MS: 4.5 * 60 * 1000,
  TIMEZONE: 'Asia/Tokyo',
};

const DISCORD_API = 'https://discord.com/api/v10';
const NOTION_API = 'https://api.notion.com/v1';
const NOTION_VERSION = '2026-03-11';

// Discordのチャンネル種別
const CH_CATEGORY = 4;
const MESSAGE_CHANNEL_TYPES = [0, 5];          // テキスト・アナウンス（自分の投稿を持つ）
const THREAD_PARENT_TYPES = [0, 5, 15, 16];    // スレッドを持てる（15=フォーラム, 16=メディア）
const THREAD_TYPES = [10, 11, 12];
const COPY_MESSAGE_TYPES = [0, 19];            // 通常・返信。参加通知などのシステム投稿は写さない
const MSG_PIN_NOTICE = 6;                      // 「〇〇がメッセージをピン留めしました」の知らせ

// スト6のキャラ名の読み替え。同じ行の名前は同じキャラとして、チャンネル名とNotionのページ名を結び付ける。
// （ベガの海外名は M.Bison。日本の「バイソン」は別キャラなので入れない）
const SF6_ALIASES = [
  ['リュウ', 'ryu'], ['ケン', 'ken'], ['豪鬼', 'ゴウキ', 'akuma', 'gouki'], ['ルーク', 'luke'],
  ['ジェイミー', 'jamie'], ['春麗', 'チュンリー', 'chunli'], ['ガイル', 'guile'], ['キンバリー', 'キンバ', 'kimberly'],
  ['ジュリ', 'juri'], ['ブランカ', 'blanka'], ['ダルシム', 'dhalsim'],
  ['E.本田', 'エドモンド本田', '本田', 'ホンダ', 'ehonda', 'honda'], ['ディージェイ', 'DJ', 'deejay'],
  ['マノン', 'manon'], ['マリーザ', 'marisa'], ['JP', 'ジェイピー'], ['ザンギエフ', 'ザンギ', 'zangief'],
  ['リリー', 'lily'], ['キャミィ', 'キャミー', 'cammy'], ['ラシード', 'rashid'],
  ['A.K.I.', 'アキ', 'エーケーアイ'], ['エド', 'ed'], ['ベガ', 'mbison'], ['テリー', 'terry'],
  ['舞', '不知火舞', 'mai'], ['エレナ', 'elena'], ['サガット', 'sagat'],
  ['C.ヴァイパー', 'ヴァイパー', 'cviper', 'viper'], ['アレックス', 'alex'], ['イングリッド', 'ingrid'],
  ['ヤスミン', 'yasmine'],
];

// スクリプトプロパティのキー（進み具合）
const P_CURSOR = 'cur:';   // チャンネル/スレッドID → 転記済みの最後の投稿ID
const P_PAGE = 'pg:';      // チャンネルID → NotionページID
const P_COVER = 'cv:';     // チャンネルID → カバーにした画像の投稿ID（COVER_RULE='first'）
const P_PIN = 'pin:';      // チャンネルID → カバーにしたピン留めの投稿ID。'-' は「見たが画像なし」（COVER_RULE='pinned'）
const P_ARCHIVED = 'ar:';  // チャンネルID → アーカイブ済みスレッドの取り込み完了
const P_NOTION_DS = 'NOTION_DS_CACHE';
const P_GUILD = 'GUILD_CACHE';

// ===== 入口（GASの「実行」から選ぶ関数） =====

/** 接続と「チャンネル → Notionページ」の対応を確認する。何も書き込まない。 */
function checkSetup() {
  const ctx = newContext_();
  const lines = [];
  const out = (s) => { lines.push(s); Logger.log(s); };

  const missing = ['DISCORD_BOT_TOKEN', 'NOTION_TOKEN', 'NOTION_URL'].filter((k) => !(k === 'NOTION_URL' ? notionUrlRaw_(ctx) : getProp_(ctx, k)));
  if (missing.length) {
    out('★設定が足りません: ' + missing.join(' / '));
    out('  GitHub Actions なら Secrets、GAS ならスクリプトプロパティに入れて、もう一度 checkSetup を実行してください。');
    return lines.join('\n');
  }

  // 問題は1回の実行でまとめて見せる（1つ直すたびに次の問題が出る、を避ける）
  let ok = true;
  const problem = (e) => {
    if (!e.userFacing) throw e;
    ok = false;
    out('★' + e.message);
  };
  try {
    const app = discord_(ctx, '/applications/@me');
    out('Discordボット: ' + app.name + ' … OK');
    if (contentIntentOn_(app) === false) {
      ok = false;
      out('★メッセージの中身を読む許可（MESSAGE CONTENT INTENT）がOFFです。Discordの開発者ページ（Developer Portal）'
        + 'でこのボットを開き、左の「Bot」→「MESSAGE CONTENT INTENT」（自動翻訳だと「メッセージコンテンツの意図」）をONにして、'
        + '下の「Save Changes」（変更を保存）を押してください。');
    }
    try {
      out('サーバー: ' + resolveGuild_(ctx).name + ' … OK');
    } catch (e) {
      problem(e);
      if (e.inviteNeeded) {
        out('  次のURLを開いて、サーバー「' + CONFIG.GUILD_NAME + '」を選んで「認証」してください:');
        out('  ' + inviteUrl_(app.id));
      }
    }
  } catch (e) {
    problem(e);
  }
  try {
    const ds = notionDataSource_(ctx, { dryRun: true });
    if (ds.pending) {
      ctx.pages = []; // まだデータベースが無い = 全チャンネルのページを新しく作る
      out('Notionのページ: ' + ds.pageTitle + ' … OK（中にまだデータベースが無いので、最初の転記（sync）のときに「'
        + CONFIG.GALLERY_TITLE + '」のギャラリーを自動で作ります）');
    } else {
      out('Notionデータベース: ' + ds.title + '（ページ ' + notionPages_(ctx).length + ' 件） … OK');
    }
  } catch (e) {
    problem(e);
  }
  if (!ok) {
    out('');
    out('★の項目を直してから、もう一度 checkSetup を実行してください。');
    return lines.join('\n');
  }

  const plan = listTargets_(ctx, { probeOnly: true });
  out('');
  out('カテゴリ「' + CONFIG.CATEGORY_NAME + '」のチャンネル: ' + plan.parents.length + ' 個');
  for (const ch of plan.parents) {
    const saved = getProp_(ctx, P_PAGE + ch.id);
    let dest;
    if (saved) {
      dest = '→ 設定済みのページ';
    } else {
      const m = matchPage_(ctx, ch.name);
      if (m && m.page) dest = '→「' + m.page.title + '」' + (m.how === 'exact' ? '' : m.how === 'alias' ? '（読み替え）' : '（' + m.how + '。合っているか確認）');
      else if (m && m.create) dest = '→「' + m.create + '」を新しく作ります（CHANNEL_TO_PAGE の指定）';
      else if (m && m.ambiguous) dest = '→ 候補が複数（' + m.ambiguous.map((p) => p.title).join(' / ') + '）。CHANNEL_TO_PAGE で指定してください';
      else dest = CONFIG.CREATE_MISSING_PAGES ? '→ 同じ名前のページが無いので新しく作ります' : '→ 同じ名前のページが無いので転記しません';
    }
    const probe = probeChannel_(ctx, ch);
    let cover = '';
    if (CONFIG.COVER_RULE === 'pinned' && MESSAGE_CHANNEL_TYPES.indexOf(ch.type) >= 0 && probe.indexOf('★') < 0) {
      const pin = pinnedImage_(ctx, ch.id);
      cover = pin ? '  [サムネ: ピン留めの画像 ' + pin.attachment.filename + ']' : '  [サムネ: ピン留めの画像なし→今のカバーのまま]';
    }
    out('  #' + ch.name + '  ' + dest + probe + cover);
  }
  if (plan.excluded.length) out('除外: ' + plan.excluded.map((c) => '#' + c.name).join(' '));
  out('');
  out('問題なければ転記を始めてください（GitHub Actions なら変数 SYNC_ENABLED を true に。GAS なら startSync を実行）。');
  return lines.join('\n');
}

/** 自動転記を始める（5分ごとのトリガーを入れて、1回目をすぐ実行する）。 */
function startSync() {
  removeTriggers_();
  // 設定が間違ったままトリガーを入れると5分ごとにエラーメールが来るので、先に確かめる
  const ctx = newContext_();
  if (contentIntentOn_(discord_(ctx, '/applications/@me')) === false) {
    throw userError_('メッセージの中身を読む許可（MESSAGE CONTENT INTENT）がOFFです。checkSetup の案内に従ってONにしてください。');
  }
  notionDataSource_(ctx);
  listTargets_(ctx, { probeOnly: true });
  ScriptApp.newTrigger('sync').timeBased().everyMinutes(CONFIG.TRIGGER_MINUTES).create();
  Logger.log(CONFIG.TRIGGER_MINUTES + '分ごとの自動転記を設定しました。続けて1回目を実行します。');
  sync();
}

/** 自動転記を止める。進み具合は残るので、startSync で続きから再開できる。 */
function stopSync() {
  const n = removeTriggers_();
  Logger.log(n ? '自動転記を止めました。' : '自動転記は動いていませんでした。');
}

/** トリガーから呼ばれる本体。手で実行してもよい。 */
function sync() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) {
    Logger.log('前回の転記がまだ動いているので、今回は休みます。');
    return;
  }
  try {
    runSync_(newContext_());
  } finally {
    lock.releaseLock();
  }
}

/**
 * サムネ（カバー画像）を選び直す。
 * - COVER_RULE='pinned': ピン留めを外した・付け替えたのに変わらないとき（外しただけだと知らせが来ないため）
 * - COVER_RULE='first' : 最初の画像をDiscordで消して、別の画像に差し替えたいとき
 */
function rescanCovers() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) throw new Error('転記の実行中です。少し待ってからもう一度実行してください。');
  try {
    const ctx = newContext_();
    if (CONFIG.COVER_RULE === 'off') { Logger.log('COVER_RULE が off なので、カバーは変えません。'); return; }
    const plan = listTargets_(ctx, { allArchived: true });
    for (const ch of plan.parents) {
      if (outOfTime_(ctx)) { Logger.log('時間切れ。もう一度 rescanCovers を実行してください。'); return; }
      const isText = MESSAGE_CHANNEL_TYPES.indexOf(ch.type) >= 0;
      if (CONFIG.COVER_RULE === 'pinned') {
        if (!isText) continue;
        deleteProp_(ctx, P_PIN + ch.id);
        if (!refreshPinnedCover_(ctx, ch)) Logger.log('#' + ch.name + ': ピン留めの画像なし（カバーはそのまま）');
        continue;
      }
      const sources = isText
        ? [ch.id]
        : plan.targets.filter((t) => t.kind === 'thread' && t.channel.id === ch.id).map((t) => t.id);
      let best = null;
      for (const id of sources) {
        const found = firstImageIn_(ctx, id);
        if (found && (!best || snowCmp_(found.message.id, best.message.id) < 0)) best = found;
      }
      if (!best) { Logger.log('#' + ch.name + ': 画像なし（カバーはそのまま）'); deleteProp_(ctx, P_COVER + ch.id); continue; }
      const pageId = ensurePage_(ctx, ch);
      if (!pageId) continue;
      if (setCover_(ctx, pageId, best.attachment)) {
        setProp_(ctx, P_COVER + ch.id, best.message.id);
        Logger.log('#' + ch.name + ': カバーを更新しました（' + best.attachment.filename + '）');
      }
    }
  } finally {
    lock.releaseLock();
  }
}

// ===== 転記の本体 =====

function runSync_(ctx) {
  const plan = listTargets_(ctx, {});
  const results = {};
  let stopped = false;
  for (const t of plan.targets) {
    if (outOfTime_(ctx)) { stopped = true; break; }
    try {
      results[t.id] = syncTarget_(ctx, t);
    } catch (e) {
      if (e.stopRun) throw e;
      results[t.id] = 'error';
      Logger.log('#' + t.label + ' の転記でエラー（次の回にやり直します）: ' + e.message);
    }
    // ピン留めは「初めて見るチャンネル」と「ピン留めの知らせが来たとき」だけ確かめる（毎回は見に行かない）
    if (CONFIG.COVER_RULE === 'pinned' && t.kind === 'channel' && MESSAGE_CHANNEL_TYPES.indexOf(t.type) >= 0
        && results[t.id] !== 'forbidden' && results[t.id] !== 'timeout'
        && (ctx.pinChanged[t.channel.id] || !getProp_(ctx, P_PIN + t.channel.id))) {
      try {
        refreshPinnedCover_(ctx, t.channel);
      } catch (e) {
        if (e.stopRun) throw e;
        if (isPageGone_(e)) deleteProp_(ctx, P_PAGE + t.channel.id);
        Logger.log('#' + t.label + ' のサムネ更新でエラー（次の回にやり直します）: ' + e.message);
      }
    }
    if (results[t.id] === 'timeout') { stopped = true; break; }
  }
  // アーカイブ済みスレッドを全部取り込めたチャンネルは、次からアーカイブ一覧を見に行かない
  for (const chId of plan.archivedScanned) {
    const mine = plan.targets.filter((t) => t.archivedOf === chId);
    if (mine.every((t) => results[t.id] === 'done' || results[t.id] === 'forbidden')) setProp_(ctx, P_ARCHIVED + chId, '1');
  }
  const added = Object.keys(ctx.stats.added).map((k) => k + ' ' + ctx.stats.added[k] + '件');
  Logger.log((added.length ? '追記: ' + added.join(' / ') : '新しい投稿はありませんでした')
    + (ctx.stats.covers.length ? ' / カバー更新: ' + ctx.stats.covers.join(' ') : '')
    + (stopped ? '（時間切れ。続きは次の回）' : ''));
}

/** 1つのチャンネル（またはスレッド）の新しい投稿を転記する。戻り値: done / timeout / forbidden / skipped */
function syncTarget_(ctx, t) {
  if (MESSAGE_CHANNEL_TYPES.indexOf(t.type) < 0 && THREAD_TYPES.indexOf(t.type) < 0) return 'done';
  let cursor = getProp_(ctx, P_CURSOR + t.id) || '0';
  if (!t.lastMessageId || snowCmp_(t.lastMessageId, cursor) <= 0) return 'done';
  // 転記先ページは、書き込む中身ができてから用意する（読めないチャンネルのページを作らないため）
  let pageId = null;
  const page = () => {
    if (!pageId) pageId = ensurePage_(ctx, t.channel);
    if (!pageId) throw Object.assign(new Error('転記先ページなし'), { skipTarget: true });
    return pageId;
  };

  let pending = [];
  let pendingBlocks = 0;
  const flush = () => {
    if (!pending.length) return;
    appendItems_(ctx, t, page, pending);
    pending = [];
    pendingBlocks = 0;
  };

  try {
    for (;;) {
      if (outOfTime_(ctx)) { flush(); return 'timeout'; }
      let batch;
      try {
        batch = discord_(ctx, '/channels/' + t.id + '/messages', { after: cursor, limit: 100 });
      } catch (e) {
        if (e.code === 403 || e.code === 404) {
          Logger.log('#' + t.label + ' はボットが読めないので飛ばします（閲覧権限を確認）');
          return 'forbidden';
        }
        throw e;
      }
      if (!batch.length) break;
      batch.sort((a, b) => snowCmp_(a.id, b.id));
      assertContentVisible_(batch);
      for (const m of batch) {
        if (outOfTime_(ctx)) { flush(); return 'timeout'; }
        const item = buildMessage_(ctx, t, page, m);
        if (pendingBlocks + item.blocks.length > 100) flush();
        pending.push(item);
        pendingBlocks += item.blocks.length;
        cursor = m.id;
      }
      flush();
      if (batch.length < 100) break;
    }
    return 'done';
  } catch (e) {
    if (e.skipTarget) return 'skipped';
    if (isPageGone_(e)) {
      // Notion側でページが消された・ゴミ箱に入った → 対応を忘れて、次の回に探し直す（無ければ作り直す）
      deleteProp_(ctx, P_PAGE + t.channel.id);
      Logger.log('#' + t.label + ' の転記先ページが見つからなくなったので、次の回に探し直します');
      return 'skipped';
    }
    throw e;
  }
}

/**
 * まとめてNotionへ追記し、成功したところまで進み具合を保存する。
 * 1件のせいで全体が弾かれたとき（変なURLなど）は1件ずつ送り直し、それでも駄目な投稿は飾りなしの文字だけで送る。
 */
function appendItems_(ctx, t, page, items) {
  const last = items[items.length - 1].id;
  const blocks = [].concat.apply([], items.map((i) => i.blocks));
  if (!blocks.length) { setProp_(ctx, P_CURSOR + t.id, last); return; }
  const pageId = page();
  try {
    appendBlocks_(ctx, pageId, blocks);
  } catch (e) {
    if (e.code !== 400 || isPageGone_(e)) throw e;
    for (const it of items) {
      if (it.blocks.length) {
        try {
          appendBlocks_(ctx, pageId, it.blocks);
        } catch (e2) {
          if (e2.code !== 400 || isPageGone_(e2)) throw e2;
          Logger.log('#' + t.label + ' の投稿 ' + it.id + ' を文字だけで転記しました: ' + e2.message);
          appendBlocks_(ctx, pageId, it.safe);
        }
      }
      setProp_(ctx, P_CURSOR + t.id, it.id);
    }
  }
  setProp_(ctx, P_CURSOR + t.id, last);
  const n = items.filter((i) => i.blocks.length).length;
  if (n) ctx.stats.added[t.channel.name] = (ctx.stats.added[t.channel.name] || 0) + n;
}

function appendBlocks_(ctx, pageId, blocks) {
  notion_(ctx, 'patch', '/blocks/' + pageId + '/children', { children: blocks });
}

/** 投稿1件をNotionのブロックにする。最初の画像ならカバーにして、本文には入れない。 */
function buildMessage_(ctx, t, page, m) {
  const item = { id: m.id, blocks: [], safe: [] };
  if (m.type === MSG_PIN_NOTICE && t.kind === 'channel') ctx.pinChanged[t.channel.id] = true;
  if (COPY_MESSAGE_TYPES.indexOf(m.type) < 0) return item;
  if (m.author && m.author.bot && !CONFIG.INCLUDE_BOTS) return item;

  const attachments = messageAttachments_(m);
  let coverAttachmentId = null;
  // カバー候補: テキストチャンネルはチャンネル本体の投稿だけ（スレッドの画像では変えない）。
  // フォーラムは本体に投稿が無いので、スレッド（＝フォーラムの投稿）の中で一番古い画像。
  const coverEligible = t.kind === 'channel' || MESSAGE_CHANNEL_TYPES.indexOf(t.channel.type) < 0;
  if (CONFIG.COVER_RULE === 'first' && coverEligible) {
    const image = attachments.filter(isImage_)[0];
    if (image) {
      const coverKey = P_COVER + t.channel.id;
      const current = getProp_(ctx, coverKey);
      if (current === m.id) {
        coverAttachmentId = image.id; // やり直しの回。カバーは設定済み
      } else if (!current || snowCmp_(m.id, current) < 0) {
        if (setCover_(ctx, page(), image)) {
          setProp_(ctx, coverKey, m.id);
          coverAttachmentId = image.id;
          ctx.stats.covers.push(t.channel.name);
        }
      }
    }
  }

  const text = messageText_(ctx, m);
  const rest = attachments.filter((a) => a.id !== coverAttachmentId);
  if (!text && !rest.length) return item;

  item.blocks.push(headerBlock_(ctx, t, m, true));
  item.safe.push(headerBlock_(ctx, t, m, false));
  if (text) {
    richTextChunks_(text, true).forEach((rt) => item.blocks.push(paragraph_(rt)));
    richTextChunks_(text, false).forEach((rt) => item.safe.push(paragraph_(rt)));
  }
  for (const a of rest) {
    item.blocks.push(attachmentBlock_(ctx, t, m, a));
    item.safe.push(paragraph_([plain_('📎 ' + a.filename)]));
  }
  return item;
}

// ===== 対象のチャンネル・スレッドを集める =====

function listTargets_(ctx, opts) {
  const guild = resolveGuild_(ctx);
  const channels = discord_(ctx, '/guilds/' + guild.id + '/channels');
  ctx.channelsById = {};
  channels.forEach((c) => { ctx.channelsById[c.id] = c; });

  const cats = channels.filter((c) => c.type === CH_CATEGORY && sameName_(c.name, CONFIG.CATEGORY_NAME));
  if (!cats.length) {
    const names = channels.filter((c) => c.type === CH_CATEGORY).map((c) => c.name);
    throw userError_('カテゴリ「' + CONFIG.CATEGORY_NAME + '」が見つかりません。サーバーにあるカテゴリ: ' + names.join(' / '));
  }
  const catIds = cats.map((c) => c.id);
  const excluded = CONFIG.EXCLUDE_CHANNELS.map(norm_);
  const inCategory = channels
    .filter((c) => catIds.indexOf(c.parent_id) >= 0 && THREAD_PARENT_TYPES.indexOf(c.type) >= 0)
    .sort((a, b) => (a.position - b.position) || snowCmp_(a.id, b.id));
  const parents = inCategory.filter((c) => excluded.indexOf(norm_(c.name)) < 0);
  const plan = {
    parents: parents,
    excluded: inCategory.filter((c) => excluded.indexOf(norm_(c.name)) >= 0),
    targets: [],
    archivedScanned: [],
  };
  if (opts.probeOnly) return plan;

  const threadsByParent = {};
  const addThread = (th, archivedOf) => {
    if (THREAD_TYPES.indexOf(th.type) < 0) return;
    const list = threadsByParent[th.parent_id];
    if (!list || list.some((x) => x.id === th.id)) return;
    th.archivedOf = archivedOf || null;
    list.push(th);
  };
  parents.forEach((c) => { threadsByParent[c.id] = []; });
  if (CONFIG.INCLUDE_THREADS) {
    const active = discord_(ctx, '/guilds/' + guild.id + '/threads/active');
    (active.threads || []).forEach((th) => addThread(th, null));
    for (const c of parents) {
      if (!opts.allArchived && getProp_(ctx, P_ARCHIVED + c.id)) continue;
      const archived = archivedThreads_(ctx, c);
      if (archived === null) continue;
      archived.forEach((th) => addThread(th, c.id));
      plan.archivedScanned.push(c.id);
    }
  }

  for (const c of parents) {
    plan.targets.push({ id: c.id, kind: 'channel', type: c.type, channel: c, label: c.name, lastMessageId: c.last_message_id });
    threadsByParent[c.id].sort((a, b) => snowCmp_(a.id, b.id)).forEach((th) => {
      plan.targets.push({
        id: th.id, kind: 'thread', type: th.type, channel: c, threadName: th.name,
        label: c.name + ' / ' + th.name, lastMessageId: th.last_message_id, archivedOf: th.archivedOf,
      });
    });
  }
  return plan;
}

/** アーカイブ済みの公開スレッドを全部集める。読めないチャンネルは null。 */
function archivedThreads_(ctx, channel) {
  const all = [];
  let before;
  for (let i = 0; i < 50; i++) {
    let r;
    try {
      r = discord_(ctx, '/channels/' + channel.id + '/threads/archived/public', { before: before, limit: 100 });
    } catch (e) {
      if (e.code === 403 || e.code === 404) return null;
      throw e;
    }
    (r.threads || []).forEach((th) => all.push(th));
    if (!r.has_more || !r.threads || !r.threads.length) break;
    before = r.threads[r.threads.length - 1].thread_metadata.archive_timestamp;
  }
  return all;
}

/** ピン留めの中で、一番最後にピン留めされた画像付きの投稿を返す。無ければ null。 */
function pinnedImage_(ctx, channelId) {
  let r;
  try {
    r = discord_(ctx, '/channels/' + channelId + '/messages/pins', { limit: 50 });
  } catch (e) {
    if (e.code === 403 || e.code === 404) return null;
    throw e;
  }
  const items = (r.items || []).slice().sort((a, b) => String(b.pinned_at || '').localeCompare(String(a.pinned_at || '')));
  for (const it of items) {
    const m = it.message || {};
    const image = messageAttachments_(m).filter(isImage_)[0];
    if (image) return { message: m, attachment: image };
  }
  return null;
}

/**
 * ピン留めの画像をページのカバーにする。前回と同じピン留めなら何もしない（毎回アップロードしない）。
 * ピン留めの画像が無ければカバーは変えない（今のカバーのまま）。カバーにしたら true。
 */
function refreshPinnedCover_(ctx, channel) {
  const key = P_PIN + channel.id;
  const found = pinnedImage_(ctx, channel.id);
  if (!found) {
    setProp_(ctx, key, '-');
    return false;
  }
  if (getProp_(ctx, key) === found.message.id) return true;
  const pageId = ensurePage_(ctx, channel);
  if (!pageId) return false;
  if (!setCover_(ctx, pageId, found.attachment)) return false;
  setProp_(ctx, key, found.message.id);
  ctx.stats.covers.push(channel.name);
  return true;
}

/** チャンネルを古い順に見て、最初の画像を返す。 */
function firstImageIn_(ctx, channelId) {
  let cursor = '0';
  for (;;) {
    let batch;
    try {
      batch = discord_(ctx, '/channels/' + channelId + '/messages', { after: cursor, limit: 100 });
    } catch (e) {
      if (e.code === 403 || e.code === 404) return null;
      throw e;
    }
    if (!batch.length) return null;
    batch.sort((a, b) => snowCmp_(a.id, b.id));
    for (const m of batch) {
      if (COPY_MESSAGE_TYPES.indexOf(m.type) < 0) continue;
      if (m.author && m.author.bot && !CONFIG.INCLUDE_BOTS) continue;
      const image = messageAttachments_(m).filter(isImage_)[0];
      if (image) return { message: m, attachment: image };
    }
    if (batch.length < 100) return null;
    cursor = batch[batch.length - 1].id;
  }
}

/** checkSetup 用: チャンネルを読めるか、投稿の中身が見えるかを確かめる。 */
function probeChannel_(ctx, ch) {
  if (MESSAGE_CHANNEL_TYPES.indexOf(ch.type) < 0) return '（フォーラム）';
  if (!ch.last_message_id) return '（投稿なし）';
  try {
    const msgs = discord_(ctx, '/channels/' + ch.id + '/messages', { limit: 5 });
    try { assertContentVisible_(msgs); } catch (e) { return '  ★投稿の中身が読めません（メッセージの中身を読む許可＝MESSAGE CONTENT INTENT を確認）'; }
    return '';
  } catch (e) {
    if (e.code === 403 || e.code === 404) return '  ★ボットが読めません（チャンネルの権限「チャンネルを見る」「メッセージ履歴を読む」を確認）';
    throw e;
  }
}

// ===== Notion: データベースとページ =====

/** NOTION_URL（以前の名前 NOTION_DATABASE でもよい） */
function notionUrlRaw_(ctx) {
  return getProp_(ctx, 'NOTION_URL') || getProp_(ctx, 'NOTION_DATABASE');
}

/**
 * NOTION_URL からデータソースとタイトル列の名前を求める。
 * データベースのリンクならそれを使う。ページのリンクなら中のデータベースを使い、無ければ作る
 * （opts.dryRun のときは作らずに { pending: true } を返す）。
 */
function notionDataSource_(ctx, opts) {
  opts = opts || {};
  if (ctx.ds) return ctx.ds;
  const raw = notionUrlRaw_(ctx) || requiredProp_(ctx, 'NOTION_URL');
  const id = parseNotionId_(raw);
  if (!id) throw userError_('NOTION_URL からIDを読み取れません: ' + raw);
  const cached = getProp_(ctx, P_NOTION_DS);
  if (cached) {
    const c = JSON.parse(cached);
    if (c.from === id) { ctx.ds = c; return c; }
  }
  let db;
  try {
    db = notion_(ctx, 'get', '/databases/' + id);
  } catch (e) {
    if (e.code !== 404 && e.code !== 400) throw e;
    // ページのリンクだった場合: 中のデータベースを使う。無ければギャラリーを作る
    let page;
    try {
      page = notion_(ctx, 'get', '/pages/' + id);
    } catch (e2) {
      if (e2.code !== 404 && e2.code !== 400) throw e2;
      throw userError_('Notionのページが見つかりません。そのページの右上「…」→「接続」でコネクト（インテグレーション）を'
        + '追加したか、NOTION_URL がそのページのリンクかを確認してください。');
    }
    db = findChildDatabase_(ctx, id);
    if (!db) {
      if (opts.dryRun) return { pending: true, pageTitle: pageTitle_(page) || '(無題)' };
      db = createGallery_(ctx, id);
    }
  }
  const sources = db.data_sources || [];
  if (!sources.length) throw userError_('データベースの中身（データソース）が見つかりません');
  const schema = notion_(ctx, 'get', '/data_sources/' + sources[0].id);
  const titleProp = Object.keys(schema.properties).filter((k) => schema.properties[k].type === 'title')[0];
  const ds = { from: id, id: sources[0].id, titleProp: titleProp, title: plainText_(db.title) || '(無題)' };
  setProp_(ctx, P_NOTION_DS, JSON.stringify(ds));
  ctx.ds = ds;
  return ds;
}

/**
 * ページの中に「キャラ対」データベースを作り、カバー画像を大きく出すギャラリー表示を付ける。
 * ギャラリー表示が作れなくても転記はできる（表で見えるだけ）ので、そこは失敗しても止めない。
 */
function createGallery_(ctx, pageId) {
  const db = notion_(ctx, 'post', '/databases', {
    parent: { type: 'page_id', page_id: pageId },
    title: [plain_(CONFIG.GALLERY_TITLE)],
    is_inline: true,
    initial_data_source: { properties: { '名前': { title: {} } } },
  });
  Logger.log('Notionに「' + CONFIG.GALLERY_TITLE + '」データベースを作りました');
  try {
    notion_(ctx, 'post', '/views', {
      database_id: db.id,
      data_source_id: db.data_sources[0].id,
      name: 'ギャラリー',
      type: 'gallery',
      position: { type: 'start' },
      configuration: { type: 'gallery', cover: { type: 'page_cover' }, cover_size: 'large', cover_aspect: 'cover' },
    });
    Logger.log('ギャラリー表示（カードの画像＝ページのカバー）を付けました');
  } catch (e) {
    if (e.stopRun) throw e;
    Logger.log('ギャラリー表示は自動で付けられませんでした。Notionで「+」→「ギャラリー」を追加し、'
      + '「…」→「レイアウト」→「カードプレビュー」を「ページカバー画像」にしてください（' + e.message + '）');
  }
  return db;
}

function pageTitle_(page) {
  const props = (page && page.properties) || {};
  const k = Object.keys(props).filter((x) => props[x].type === 'title')[0];
  return k ? plainText_(props[k].title) : '';
}

function findChildDatabase_(ctx, pageId) {
  let children;
  try {
    children = notion_(ctx, 'get', '/blocks/' + pageId + '/children?page_size=100');
  } catch (e) {
    return null;
  }
  const dbs = (children.results || []).filter((b) => b.type === 'child_database');
  if (dbs.length !== 1) return null;
  return notion_(ctx, 'get', '/databases/' + dbs[0].id);
}

/** データベースのページ一覧（タイトル付き）。1回の実行で1度だけ読む。 */
function notionPages_(ctx) {
  if (ctx.pages) return ctx.pages;
  const ds = notionDataSource_(ctx);
  const pages = [];
  let cursor;
  do {
    const r = notion_(ctx, 'post', '/data_sources/' + ds.id + '/query', { page_size: 100, start_cursor: cursor });
    (r.results || []).forEach((p) => {
      if (p.object !== 'page') return;
      const prop = p.properties && p.properties[ds.titleProp];
      pages.push({ id: p.id, title: prop ? plainText_(prop.title) : '' });
    });
    cursor = r.has_more ? r.next_cursor : null;
  } while (cursor);
  ctx.pages = pages;
  return pages;
}

/**
 * チャンネル名に合うページを探す。記号・空白・大文字小文字・全角半角の違いは無視する
 * （Discordは「A.K.I.」を「a-k-i」のように変えるため）。完全一致が無ければスト6のキャラ名の
 * 読み替え（「ディージェイ」と「DJ」など）、それも無ければ片方がもう片方を含むもののうち一番長い名前を選ぶ。
 */
function matchPage_(ctx, channelName) {
  const pages = notionPages_(ctx).filter((p) => norm_(p.title));
  const override = overrideFor_(channelName);
  if (override) {
    const hit = pages.filter((p) => norm_(p.title) === norm_(override));
    if (hit.length === 1) return { page: hit[0], how: 'exact' };
    if (hit.length > 1) return { ambiguous: hit };
    return { create: override };
  }
  const n = norm_(channelName);
  if (!n) return null;
  let hit = pages.filter((p) => norm_(p.title) === n);
  if (hit.length === 1) return { page: hit[0], how: 'exact' };
  if (hit.length > 1) return { ambiguous: hit };
  const group = CONFIG.USE_SF6_ALIASES ? SF6_ALIASES.filter((g) => g.some((x) => norm_(x) === n))[0] : null;
  if (group) {
    const names = group.map(norm_);
    hit = pages.filter((p) => names.indexOf(norm_(p.title)) >= 0);
    if (hit.length === 1) return { page: hit[0], how: 'alias' };
    if (hit.length > 1) return { ambiguous: hit };
    // 既知のキャラなのにページが無い → 新しく作る。部分一致に進むと「エドモンド本田」が「エド」に入ってしまう
    return null;
  }
  hit = pages.filter((p) => { const pn = norm_(p.title); return n.indexOf(pn) >= 0 || pn.indexOf(n) >= 0; });
  if (!hit.length) return null;
  const longest = Math.max.apply(null, hit.map((p) => norm_(p.title).length));
  hit = hit.filter((p) => norm_(p.title).length === longest);
  return hit.length === 1 ? { page: hit[0], how: '部分一致' } : { ambiguous: hit };
}

function overrideFor_(channelName) {
  const keys = Object.keys(CONFIG.CHANNEL_TO_PAGE);
  const k = keys.filter((key) => norm_(key) === norm_(channelName))[0];
  return k ? CONFIG.CHANNEL_TO_PAGE[k] : null;
}

/** チャンネルの転記先ページIDを返す。初回は名前で探し、無ければ作る。 */
function ensurePage_(ctx, channel) {
  const key = P_PAGE + channel.id;
  const saved = getProp_(ctx, key);
  if (saved) return saved;
  const m = matchPage_(ctx, channel.name);
  if (m && m.page) {
    setProp_(ctx, key, m.page.id);
    Logger.log('#' + channel.name + ' → Notionの「' + m.page.title + '」に転記します');
    return m.page.id;
  }
  if (m && m.ambiguous) {
    Logger.log('#' + channel.name + ': 候補のページが複数あるので転記しません（' + m.ambiguous.map((p) => p.title).join(' / ')
      + '）。CONFIG.CHANNEL_TO_PAGE で指定してください');
    return null;
  }
  if (!CONFIG.CREATE_MISSING_PAGES) {
    Logger.log('#' + channel.name + ': 同じ名前のページが無いので転記しません');
    return null;
  }
  const ds = notionDataSource_(ctx);
  const title = (m && m.create) || channel.name;
  const props = {};
  props[ds.titleProp] = { title: [plain_(title)] };
  const page = notion_(ctx, 'post', '/pages', { parent: { type: 'data_source_id', data_source_id: ds.id }, properties: props });
  setProp_(ctx, key, page.id);
  if (ctx.pages) ctx.pages.push({ id: page.id, title: title });
  Logger.log('#' + channel.name + ' → Notionに「' + title + '」を新しく作りました');
  return page.id;
}

// ===== Notion: 画像・ファイル =====

/** 画像をNotionへアップロードして、ページのカバーにする。 */
function setCover_(ctx, pageId, attachment) {
  const uploadId = uploadAttachment_(ctx, attachment);
  if (!uploadId) {
    Logger.log('カバーにする画像を上げられませんでした: ' + attachment.filename);
    return false;
  }
  try {
    notion_(ctx, 'patch', '/pages/' + pageId, { cover: { type: 'file_upload', file_upload: { id: uploadId } } });
  } catch (e) {
    if (e.stopRun || isPageGone_(e)) throw e;
    Logger.log('カバーを設定できませんでした（' + attachment.filename + '）: ' + e.message);
    return false;
  }
  return true;
}

function attachmentBlock_(ctx, t, m, a) {
  const uploadId = uploadAttachment_(ctx, a);
  if (uploadId) {
    const ct = (a.content_type || '').split(';')[0];
    const kind = isImage_(a) ? 'image' : ct.indexOf('video/') === 0 ? 'video' : ct === 'application/pdf' ? 'pdf' : 'file';
    const block = { object: 'block', type: kind };
    block[kind] = { type: 'file_upload', file_upload: { id: uploadId } };
    return block;
  }
  // 大きすぎるなどで上げられないファイルは、Discordの投稿へのリンクにする（ファイルのURLは失効するため）
  return paragraph_([plain_('📎 ' + a.filename + '（Discordで見る）', messageUrl_(ctx, t, m))]);
}

/** Discordの添付をダウンロードしてNotionへ上げる。上げられなければ null。 */
function uploadAttachment_(ctx, a) {
  const limit = CONFIG.NOTION_FILE_LIMIT_MB * 1024 * 1024;
  let url = a.url;
  if (a.size > limit) {
    // 大きい画像はDiscordの縮小版を取り直す
    if (!isImage_(a) || !a.proxy_url || !a.width || !a.height) return null;
    const w = Math.min(1600, a.width);
    url = a.proxy_url + (a.proxy_url.indexOf('?') >= 0 ? '&' : '?') + 'width=' + w + '&height=' + Math.round(a.height * w / a.width);
  }
  try {
    const res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    if (res.getResponseCode() !== 200) return null;
    const blob = res.getBlob();
    if (blob.getBytes().length > limit) return null;
    const contentType = String(header_(res, 'content-type') || a.content_type || '').split(';')[0].trim();
    const filename = filenameFor_(a.filename, contentType);
    blob.setName(filename);
    const body = { filename: filename };
    if (contentType && contentType !== 'application/octet-stream') {
      body.content_type = contentType;
      blob.setContentType(contentType);
    }
    const fu = notion_(ctx, 'post', '/file_uploads', body);
    const sent = notionMultipart_(ctx, '/file_uploads/' + fu.id + '/send', blob);
    return sent.status === 'uploaded' ? fu.id : null;
  } catch (e) {
    if (e.stopRun) throw e;
    Logger.log('ファイルを上げられませんでした（' + a.filename + '）: ' + e.message);
    return null;
  }
}

/** 縮小版はwebpなどで返ってくることがあるので、拡張子を中身に合わせる（Notionは食い違うと弾く）。 */
function filenameFor_(name, contentType) {
  const ext = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' }[contentType];
  const base = String(name || 'file').replace(/["\\/]/g, '_');
  if (!ext) return base;
  const stem = base.replace(/\.[^.]+$/, '');
  const cur = (base.match(/\.([^.]+)$/) || [])[1];
  if (cur && (cur.toLowerCase() === ext || (ext === 'jpg' && cur.toLowerCase() === 'jpeg'))) return base;
  return stem + '.' + ext;
}

// ===== 投稿の見た目 =====

/** 見出し行: 投稿者（太字）・日時（Discordの投稿へのリンク）・スレッド名・返信先 */
function headerBlock_(ctx, t, m, withLink) {
  const rt = [plain_(authorName_(m.author), null, { bold: true })];
  rt.push(plain_('  ' + formatDate_(m.timestamp), withLink ? messageUrl_(ctx, t, m) : null, { color: 'gray' }));
  if (t.threadName) rt.push(plain_('  🧵 ' + t.threadName, null, { color: 'gray' }));
  if (m.type === 19 && m.referenced_message && m.referenced_message.author) {
    rt.push(plain_('  ↪ ' + authorName_(m.referenced_message.author) + ' への返信', null, { color: 'gray' }));
  }
  return paragraph_(rt);
}

/** 本文。メンションや絵文字の記法を読める形に直す。転送された投稿は中身を写す。 */
function messageText_(ctx, m) {
  let text = m.content || '';
  if (!text && m.message_snapshots && m.message_snapshots.length) {
    const snap = m.message_snapshots[0].message || {};
    text = snap.content ? '（転送）\n' + snap.content : '';
  }
  const users = {};
  (m.mentions || []).forEach((u) => { users[u.id] = authorName_(u); });
  text = text
    .replace(/<@!?(\d+)>/g, (s, id) => '@' + (users[id] || 'ユーザー'))
    .replace(/<@&(\d+)>/g, (s, id) => '@' + roleName_(ctx, id))
    .replace(/<#(\d+)>/g, (s, id) => '#' + ((ctx.channelsById && ctx.channelsById[id] && ctx.channelsById[id].name) || 'チャンネル'))
    .replace(/<a?:(\w+):\d+>/g, ':$1:')
    .replace(/<t:(\d+)(?::[tTdDfFR])?>/g, (s, sec) => formatDate_(new Date(Number(sec) * 1000).toISOString()))
    .replace(/<(https?:\/\/[^\s>]+)>/g, '$1');
  const stickers = (m.sticker_items || []).map((s) => '[スタンプ: ' + s.name + ']');
  if (stickers.length) text = (text ? text + '\n' : '') + stickers.join(' ');
  return text.trim();
}

/** 文字をNotionの段落に分ける（1要素2000字・1段落100要素まで）。URLはリンクにする。 */
function richTextChunks_(text, linkify) {
  const parts = [];
  // URLに使える半角文字だけを拾う（日本語が続けて書かれても巻き込まない）。末尾の句読点・閉じ括弧は外す
  const re = /https?:\/\/[A-Za-z0-9\-._~:/?#\[\]@!$&'()*+,;=%]+/g;
  let last = 0;
  let m;
  if (linkify) {
    while ((m = re.exec(text))) {
      const url = m[0].replace(/[.,!?;:'")\]]+$/, '');
      if (url.length < 10) continue;
      if (m.index > last) parts.push({ s: text.slice(last, m.index) });
      parts.push({ s: url, url: url.length <= 2000 ? url : null });
      last = m.index + url.length;
      re.lastIndex = last;
    }
  }
  if (last < text.length) parts.push({ s: text.slice(last) });
  const items = [];
  parts.forEach((p) => {
    for (let i = 0; i < p.s.length; i += 2000) items.push(plain_(p.s.slice(i, i + 2000), p.url));
  });
  const chunks = [];
  for (let i = 0; i < items.length; i += 100) chunks.push(items.slice(i, i + 100));
  return chunks;
}

function paragraph_(richText) {
  return { object: 'block', type: 'paragraph', paragraph: { rich_text: richText } };
}

function plain_(content, url, annotations) {
  const o = { type: 'text', text: { content: content } };
  if (url) o.text.link = { url: url };
  if (annotations) o.annotations = annotations;
  return o;
}

function authorName_(u) {
  return (u && (u.global_name || u.username)) || '不明';
}

function roleName_(ctx, id) {
  if (!ctx.roles) {
    ctx.roles = {};
    try {
      discord_(ctx, '/guilds/' + resolveGuild_(ctx).id + '/roles').forEach((r) => { ctx.roles[r.id] = r.name; });
    } catch (e) { /* ロール名が取れなくても本文は写せる */ }
  }
  return ctx.roles[id] || 'ロール';
}

function messageUrl_(ctx, t, m) {
  return 'https://discord.com/channels/' + resolveGuild_(ctx).id + '/' + (m.channel_id || t.id) + '/' + m.id;
}

function formatDate_(iso) {
  return Utilities.formatDate(new Date(iso), CONFIG.TIMEZONE, 'yyyy/MM/dd HH:mm');
}

function messageAttachments_(m) {
  if (m.attachments && m.attachments.length) return m.attachments;
  const snap = m.message_snapshots && m.message_snapshots[0] && m.message_snapshots[0].message;
  return (snap && snap.attachments) || [];
}

function isImage_(a) {
  return /^image\//.test(a.content_type || '') || /\.(png|jpe?g|gif|webp)$/i.test(a.filename || '');
}

/**
 * Message Content Intent がOFFだと、投稿の中身が空で返ってくる。そのまま進めると
 * 「転記したことにして中身が抜ける」ので、気づいた時点で止める。
 */
function assertContentVisible_(messages) {
  const blank = messages.filter((m) => COPY_MESSAGE_TYPES.indexOf(m.type) >= 0 && !(m.author && m.author.bot)
    && !m.content && !(m.attachments || []).length && !(m.embeds || []).length && !(m.sticker_items || []).length
    && !(m.message_snapshots || []).length && !m.poll);
  if (blank.length) {
    const e = userError_('投稿の中身が空で返ってきました。メッセージの中身を読む許可（MESSAGE CONTENT INTENT）がOFFです。'
      + 'Discordの開発者ページ（Developer Portal）の「Bot」でONにして「Save Changes」を押してください。（ONにするまで転記は進めません）');
    e.stopRun = true;
    throw e;
  }
}

// ===== Discord =====

function resolveGuild_(ctx) {
  if (ctx.guild) return ctx.guild;
  const explicit = getProp_(ctx, 'DISCORD_GUILD_ID');
  if (explicit) {
    ctx.guild = discord_(ctx, '/guilds/' + explicit);
    return ctx.guild;
  }
  const cached = getProp_(ctx, P_GUILD);
  if (cached) { ctx.guild = JSON.parse(cached); return ctx.guild; }
  const guilds = discord_(ctx, '/users/@me/guilds');
  if (!guilds.length) {
    const e = userError_('ボットがまだサーバーに入っていません。');
    e.inviteNeeded = true;
    throw e;
  }
  let g = guilds.length === 1 ? guilds[0] : guilds.filter((x) => sameName_(x.name, CONFIG.GUILD_NAME))[0];
  if (!g) {
    throw userError_('ボットが複数のサーバーに入っています（' + guilds.map((x) => x.name).join(' / ')
      + '）。スクリプトプロパティ DISCORD_GUILD_ID にサーバーIDを入れてください。');
  }
  ctx.guild = { id: g.id, name: g.name };
  setProp_(ctx, P_GUILD, JSON.stringify(ctx.guild));
  return ctx.guild;
}

/** ボットの招待URL（権限は「チャンネルを見る」＋「メッセージ履歴を読む」だけ） */
function inviteUrl_(clientId) {
  return 'https://discord.com/oauth2/authorize?client_id=' + clientId + '&scope=bot&permissions=' + ((1 << 10) | (1 << 16));
}

/**
 * Developer Portal の MESSAGE CONTENT INTENT がONか（ONにすると1<<19、認証済みボットは1<<18が立つ）。
 * flags が返ってこなければ分からない（null）。その場合も転記中に中身が空なら止まるので取りこぼさない。
 */
function contentIntentOn_(app) {
  if (typeof app.flags !== 'number') return null;
  return (app.flags & ((1 << 18) | (1 << 19))) !== 0;
}

function discord_(ctx, path, params) {
  const url = DISCORD_API + path + qs_(params);
  for (let attempt = 0; ; attempt++) {
    const res = UrlFetchApp.fetch(url, {
      headers: { Authorization: 'Bot ' + requiredProp_(ctx, 'DISCORD_BOT_TOKEN') },
      muteHttpExceptions: true,
    });
    const code = res.getResponseCode();
    const body = res.getContentText();
    if ((code === 429 || code >= 500) && attempt < 4) {
      let wait = 1000 * Math.pow(2, attempt);
      try { wait = Math.ceil(JSON.parse(body).retry_after * 1000) + 250; } catch (e) {
        const h = Number(header_(res, 'retry-after'));
        if (h) wait = h * 1000 + 250; else if (code === 429) wait = 5000; // Cloudflareの制限はJSONで返らない
      }
      Utilities.sleep(Math.min(wait, 30000));
      continue;
    }
    if (code === 401) {
      const e = userError_('Discordのボットトークンが違います（DISCORD_BOT_TOKEN を確認）');
      e.stopRun = true;
      throw e;
    }
    if (code >= 400) {
      const e = httpError_('Discord', code, body, path);
      if (code === 429 || code >= 500) e.stopRun = true; // 混んでいるので今回は終わり、次の回にやり直す
      throw e;
    }
    return JSON.parse(body);
  }
}

// ===== Notion =====

function notion_(ctx, method, path, body) {
  for (let attempt = 0; ; attempt++) {
    throttleNotion_(ctx);
    const opts = {
      method: method,
      headers: { Authorization: 'Bearer ' + requiredProp_(ctx, 'NOTION_TOKEN'), 'Notion-Version': NOTION_VERSION },
      muteHttpExceptions: true,
    };
    if (body !== undefined) {
      opts.contentType = 'application/json';
      opts.payload = JSON.stringify(body);
    }
    const res = UrlFetchApp.fetch(NOTION_API + path, opts);
    const r = handleNotion_(ctx, res, method + ' ' + path, attempt);
    if (r.retry) continue;
    return r.value;
  }
}

function notionMultipart_(ctx, path, blob) {
  for (let attempt = 0; ; attempt++) {
    throttleNotion_(ctx);
    const res = UrlFetchApp.fetch(NOTION_API + path, {
      method: 'post',
      headers: { Authorization: 'Bearer ' + requiredProp_(ctx, 'NOTION_TOKEN'), 'Notion-Version': NOTION_VERSION },
      payload: { file: blob }, // Blobを渡すとGASが multipart/form-data で送る
      muteHttpExceptions: true,
    });
    const r = handleNotion_(ctx, res, 'post ' + path, attempt);
    if (r.retry) continue;
    return r.value;
  }
}

function handleNotion_(ctx, res, what, attempt) {
  const code = res.getResponseCode();
  const text = res.getContentText();
  if ((code === 429 || code === 409 || code >= 500) && attempt < 4) {
    const h = Number(header_(res, 'retry-after'));
    Utilities.sleep(Math.min(h ? h * 1000 + 250 : 1000 * Math.pow(2, attempt), 30000));
    return { retry: true };
  }
  if (code === 401) {
    const e = userError_('Notionのトークンが違います（NOTION_TOKEN を確認）');
    e.stopRun = true;
    throw e;
  }
  if (code === 403 && /restricted_resource/.test(text)) {
    // 無料プランでメンバー2人以上のワークスペースは生涯1,000ブロックまで。超えると全部の書き込みが403になる
    const e = userError_('Notionのワークスペースが無料プランのブロック上限（メンバー2人以上で1,000ブロック）に達していて、'
      + 'これ以上書き込めません。Notionのオーナーに、有料プランにするか、メンバーをオーナー1人だけ（ほかはゲスト）に'
      + 'してもらってください。転記は止めています。直れば次の回から自動で続きを書きます。');
    e.stopRun = true;
    throw e;
  }
  if (code >= 400) {
    const e = httpError_('Notion', code, text, what);
    if (code === 429 || code >= 500) e.stopRun = true;
    throw e;
  }
  return { value: JSON.parse(text) };
}

/** Notionは平均で毎秒3回までなので、呼び出しの間を空ける。 */
function throttleNotion_(ctx) {
  const wait = 340 - (Date.now() - (ctx.lastNotion || 0));
  if (wait > 0) Utilities.sleep(wait);
  ctx.lastNotion = Date.now();
}

/** ページが消された・ゴミ箱に入った・接続が外れた */
function isPageGone_(e) {
  return e && e.service === 'Notion' && (e.code === 404 || (e.code === 400 && /archived|in_trash|trash/i.test(e.body || '')));
}

// ===== 共通 =====

function newContext_() {
  return {
    t0: Date.now(),
    props: PropertiesService.getScriptProperties().getProperties(),
    stats: { added: {}, covers: [] },
    pinChanged: {}, // ピン留めの知らせ（type 6）を見たチャンネル
  };
}

function outOfTime_(ctx) {
  return Date.now() - ctx.t0 > CONFIG.TIME_BUDGET_MS;
}

function getProp_(ctx, key) {
  return ctx.props[key] || null;
}

function requiredProp_(ctx, key) {
  const v = getProp_(ctx, key);
  if (!v) {
    const e = userError_('設定 ' + key + ' が入っていません（GitHub Actions なら Secrets、GAS ならスクリプトプロパティ）');
    e.stopRun = true;
    throw e;
  }
  return String(v).trim();
}

function setProp_(ctx, key, value) {
  PropertiesService.getScriptProperties().setProperty(key, String(value));
  ctx.props[key] = String(value);
}

function deleteProp_(ctx, key) {
  PropertiesService.getScriptProperties().deleteProperty(key);
  delete ctx.props[key];
}

function removeTriggers_() {
  let n = 0;
  ScriptApp.getProjectTriggers().forEach((tr) => {
    if (tr.getHandlerFunction() === 'sync') { ScriptApp.deleteTrigger(tr); n++; }
  });
  return n;
}

/** DiscordのIDは時刻順の大きな数字。桁数→文字列の順で比べる（数値にすると桁あふれする）。 */
function snowCmp_(a, b) {
  a = String(a); b = String(b);
  if (a.length !== b.length) return a.length - b.length;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** 名前の比較用: 文字と数字だけ残す（全角半角・大文字小文字・記号・絵文字・空白の違いを無視） */
function norm_(s) {
  return String(s || '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

function sameName_(a, b) {
  return norm_(a) === norm_(b);
}

/** NotionのURL（…/タイトル-<32桁>?v=…）かIDそのものから、32桁のIDを取り出す。 */
function parseNotionId_(raw) {
  const s = String(raw || '').trim().split(/[?#]/)[0];
  const uuid = s.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  if (uuid) return uuid[0].replace(/-/g, '').toLowerCase();
  const tail = s.split('/').pop().match(/[0-9a-f]{32}$/i); // タイトルの後ろに付いている32桁
  if (tail) return tail[0].toLowerCase();
  const any = s.match(/[0-9a-f]{32}/i);
  return any ? any[0].toLowerCase() : null;
}

function plainText_(rich) {
  return (rich || []).map((r) => r.plain_text || (r.text && r.text.content) || '').join('');
}

function header_(res, name) {
  const h = res.getHeaders() || {};
  const k = Object.keys(h).filter((x) => x.toLowerCase() === name)[0];
  return k ? h[k] : null;
}

function qs_(params) {
  const keys = Object.keys(params || {}).filter((k) => params[k] !== undefined && params[k] !== null);
  return keys.length ? '?' + keys.map((k) => encodeURIComponent(k) + '=' + encodeURIComponent(params[k])).join('&') : '';
}

function userError_(message) {
  const e = new Error(message);
  e.userFacing = true;
  return e;
}

function httpError_(service, code, body, what) {
  let detail = body;
  try { detail = JSON.parse(body).message || body; } catch (e) { /* JSONでない */ }
  const e = new Error(service + ' ' + code + ' (' + what + '): ' + String(detail).slice(0, 300));
  e.service = service;
  e.code = code;
  e.body = body;
  return e;
}
