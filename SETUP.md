# ブレモデイレポ自動更新 - セットアップガイド

## 概要
GitHub Actionsを使って毎朝7:00(JST)に自動実行されます。
PCがオフでもクラウド上で動作します。

## アーキテクチャ
```
[GitHub Actions] → [ecforce] CSVダウンロード (Playwright)
                 → [Google Sheets API] データ確認・インポート・検証
                 → [Chatwork] 結果通知 / 2FA通知
```

## セットアップ手順

### 1. Google Service Account の作成

1. [Google Cloud Console](https://console.cloud.google.com/) にアクセス
2. 新しいプロジェクトを作成（またはは既存のものを使用）
3. 「APIとサービス」→「ライブラリ」で以下を有効化:
   - Google Sheets API
   - Google Drive API
4. 「APIとサービス」→「認証情報」→「認証情報を作成」→「サービスアカウント」
5. サービスアカウントを作成し、キー(JSON)をダウンロード
6. **重要**: デイレポのスプレッドシートをサービスアカウントのメールアドレスと共有する
   - スプレッドシートを開き「共有」→ サービスアカウントのメール(xxx@xxx.iam.gserviceaccount.com)を追加
   - 権限: 「編集者」

### 2. GitHubリポジトリの作成

1. GitHubで新しいプライベートリポジトリを作成
2. `bremo-automation` フォルダの内容をプッシュ

### 3. GitHub Secretsの設定

リポジトリの Settings → Secrets and variables → Actions で以下を追加:

| Secret名 | 値 |
|---|---|
| `ECFORCE_EMAIL` | `navy@symbe.co.jp` |
| `ECFORCE_PASSWORD` | `canow1234` |
| `GOOGLE_CREDENTIALS` | サービスアカウントのJSONキー（1行に整形） |
| `CHATWORK_API_TOKEN` | `1961ab94b73bd52cfb2d433c9aaf8cd5` |
| `CHATWORK_ROOM_ID` | `429157045` |

### 4. 初回テスト

1. GitHubリポジトリの「Actions」タブを開く
2. 「Bremo Daily Report Auto Update」ワークフローを選択
3. 「Run workflow」で手動実行

## 日常運用

- **毎朝7:00 JST** に自動実行
- 結果はChatworkの「ブレモデイレポ更新通知」グループに通知
- 2段階認証が必要な場合もChatworkに通知が届く

### 手動実行

GitHubの Actions タブから「Run workflow」で手動実行可能。
日付を指定することもできます。

## トラブルシューティング

### 2段階認証が求められた場合
1. Chatworkに通知が届く
2. ecforceに手動でログインして認証を完了
3. GitHub Actionsから再実行

### データが反映されない場合
1. GitHub Actionsのログを確認
2. Google Service Accountにスプレッドシートの共有権限があるか確認
3. ecforceのログイン情報が正しいか確認
