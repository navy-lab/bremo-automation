const chatwork = require('./chatwork');

async function main() {
  console.log('Chatwork通知テスト...');
  await chatwork.sendMessage('[info][title]テスト通知[/title]ブレモデイレポ自動更新のChatwork通知テストです。\nこのメッセージが届いていれば設定は正常です。[/info]');
  console.log('送信完了');
}

main().catch(console.error);
