# キャラ対転記（Discord → Notion）

Discordの「キャラ対」カテゴリの投稿を、Notionの同じ名前のページへ**30分ごと**に追記します。
ピン留めした画像は、そのページのカバー（ギャラリーのサムネ）になります。

GitHub Actions（GitHubが無料で定期実行してくれる仕組み）で動くので、PCを点けておく必要はありません。
転記の本体は `sync.gs`、それを動かす部品が `runner/`、進み具合が `state/state.json` です。

> ★GAS（Google Apps Script）では動きません。GoogleのサーバーからDiscordへボットとして通信すると、
> Discordの入口で 403（internal network error）として止められるためです（2026年時点）。

## 最初の設定（10分）

GitHubの画面は英語です。ボタン名は英語のまま書き、カッコに意味を添えています。

### 1. トークンを3つ入れる

1. このリポジトリの上のタブ「**Settings**」（設定）
2. 左のメニュー「**Secrets and variables**」→「**Actions**」
3. 「**New repository secret**」（新しい秘密の値）を押して、次の3つを1つずつ入れる。
   「Name」に左の名前を**大文字のまま正確に**、「Secret」に値を貼って「**Add secret**」

   | Name | 値 |
   |---|---|
   | `DISCORD_BOT_TOKEN` | Discordのボットのトークン |
   | `NOTION_TOKEN` | NotionのコネクトのAPIトークン |
   | `NOTION_URL` | 転記先のNotionページ（またはギャラリー）のリンク |

   入れた値は二度と表示されません（GitHubが伏せて保管します）。間違えたら同じ名前で入れ直せば上書きされます。

### 2. 確認（checkSetup）を実行する

1. 上のタブ「**Actions**」→ 左の「**キャラ対転記**」
2. 右の「**Run workflow**」（実行）▼ →「実行するもの」が `checkSetup` になっていることを確認 → 緑の「**Run workflow**」
3. 数秒後に一覧に出る実行（黄色→緑か赤）を押す →「**run**」→「**実行**」の行を開くと、結果が読める
   - `★` の行が直すところ。全部まとめて出る
   - `★ボットがまだサーバーに入っていません` → 下に出るURLを開いて、サーバーを選んで「認証」
   - `★` が無くなると、「チャンネル → Notionページ」の対応と、サムネの見込みが出る
4. 直したら、もう一度 1〜3

### 3. 自動転記をオンにする

1. 「**Settings**」→「**Secrets and variables**」→「**Actions**」→ 上の「**Variables**」タブ
2. 「**New repository variable**」→ Name に `SYNC_ENABLED`、Value に `true` →「**Add variable**」
3. 以後30分ごとに自動で転記する。すぐ1回動かしたいときは、2 の手順で `sync` を選んで実行

**止めるとき**: `SYNC_ENABLED` を `false` に変える（進み具合は残るので、`true` に戻せば続きから）。

## ふだんの使い方

- **サムネ**: チャンネルでサムネにしたい画像をピン留めする（最後にピン留めした画像がサムネ）
- **投稿**: 30分ごと（GitHubの都合で少し遅れることがある）に、同じ名前のページの末尾へ追記される
- **サムネを選び直す**: ピン留めを外しただけでは変わらないので、手動実行で `rescanCovers`
- Discordでの編集・削除はNotionへ反映されない（追記だけ）
- 失敗が続くと、GitHubからメールが届く。実行の結果に `★` で原因が出る

## 無料枠

非公開リポジトリのGitHub Actionsは月2,000分まで無料です。30分ごとの実行は月およそ1,500分なので収まります。
間隔を短くしたいときは `.github/workflows/sync.yml` の `cron` を変えますが、15分ごとだと無料枠を超えます。
