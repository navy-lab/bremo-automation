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
    const { daysBehind, isFinalSlot, criticalStale } = ctx;
    const lines = [
      '[info][title]【ブレモデイレポ】エラー発生[/title]',
      `エラー: ${error.message || error}`,
      '',
    ];
    if (criticalStale) {
      lines.push(`⚠ 未取込が ${daysBehind} 日分累積しています。早めにご確認ください。`);
    } else if (isFinalSlot) {
      lines.push('本日の最終リカバリ枠でも取得できませんでした（朝〜午後を通して失敗）。');
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
