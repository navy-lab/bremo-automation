const https = require('https');
const config = require('./config');

function sendMessage(message) {
  return new Promise((resolve, reject) => {
    const body = `body=${encodeURIComponent(message)}`;
    const options = {
      hostname: 'api.chatwork.com',
      port: 443,
      path: `/v2/rooms/${config.CHATWORK.ROOM_ID}/messages`,
      method: 'POST',
      headers: {
        'X-ChatWorkToken': config.CHATWORK.API_TOKEN,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          console.log('Chatwork通知送信完了');
          resolve(JSON.parse(data));
        } else {
          console.error(`Chatwork API error: ${res.statusCode} ${data}`);
          reject(new Error(`Chatwork API error: ${res.statusCode}`));
        }
      });
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

module.exports = {
  async notify2FA(screenshotInfo) {
    const msg = [
      '[info][title]【ブレモデイレポ】2段階認証が必要です[/title]',
      'ecforceログイン時に2段階認証が求められました。',
      '手動でログインして認証を完了した後、GitHub Actionsから再実行してください。',
      '',
      `発生時刻: ${new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })}`,
      screenshotInfo ? `スクリーンショット: ${screenshotInfo}` : '',
      '[/info]',
    ].join('\n');
    return sendMessage(msg);
  },

  async notifySuccess(result) {
    const msg = [
      '[info][title]【ブレモデイレポ】自動更新完了[/title]',
      `対象期間: ${result.period}`,
      '',
      '■ インポート結果:',
      ...result.imported.map(r => `  ${r}`),
      '',
      `■ 検証: ${result.verification}`,
      ...(result.isRecovery ? ['', '※ リカバリ枠での取得です（朝の自動取得が遅延/失敗したため自動補完。対応不要）。'] : []),
      '',
      `実行時刻: ${new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })}`,
      '[/info]',
    ].join('\n');
    return sendMessage(msg);
  },

  async notifyError(error, ctx = {}) {
    const { daysBehind, isWatchdog, isFinalSlot, criticalStale } = ctx;
    // watchdog(10時)だけの遅延は「自動再取得中のお知らせ」、最終枠失敗/累積は「エラー」として出し分け
    const headsUpOnly = isWatchdog && !isFinalSlot && !criticalStale;
    const title = headsUpOnly ? '取込み遅延のお知らせ' : 'エラー発生';
    const lines = [
      `[info][title]【ブレモデイレポ】${title}[/title]`,
      `エラー: ${error.message || error}`,
      '',
    ];
    if (criticalStale) {
      lines.push(`⚠ 未取込が ${daysBehind} 日分累積しています。早めにご確認ください。`);
    } else if (isFinalSlot) {
      lines.push('本日の最終リカバリ枠(14時)でも取得できませんでした（朝〜午後を通して失敗）。手動での再実行をご検討ください。');
    } else if (isWatchdog) {
      lines.push('10時時点でまだ前日分を取込めていません（ca-now.jpの朝の不応答が継続している可能性）。14時の最終枠で自動再取得を試みます。念のためのお知らせです。');
    }
    lines.push(
      '',
      `発生時刻: ${new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })}`,
      'GitHub Actionsのログを確認してください。',
      '[/info]',
    );
    return sendMessage(lines.join('\n'));
  },

  async notifyNoData() {
    const msg = [
      '[info][title]【ブレモデイレポ】データ取得不要[/title]',
      'デイレポは最新の状態です（昨日分まで反映済み）。',
      `確認時刻: ${new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })}`,
      '[/info]',
    ].join('\n');
    return sendMessage(msg);
  },

  sendMessage,
};
