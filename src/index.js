const ecforce = require('./ecforce');
const sheets = require('./sheets');
const chatwork = require('./chatwork');
const config = require('./config');

async function main() {
  console.log('===== Bremo デイレポ自動更新 =====');
  console.log(`実行日時: ${new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })}`);

  try {
    // Step 1: Check last data date
    console.log('\n■ ステップ1: 最終データ日の確認');
    const dateRange = await sheets.getLastDataDate();

    if (!dateRange) {
      console.log('取得すべきデータなし（昨日分まで反映済み）');
      await chatwork.notifyNoData();
      return;
    }

    const { startDate, endDate } = dateRange;
    const periodStr = sheets.formatDate(startDate) === sheets.formatDate(endDate)
      ? sheets.formatDate(startDate)
      : `${sheets.formatDate(startDate)} 〜 ${sheets.formatDate(endDate)}`;

    console.log(`取得対象期間: ${periodStr}`);

    // Step 2: Download CSVs from ecforce
    console.log('\n■ ステップ2: ecforceからCSVダウンロード');
    let csvFiles;
    try {
      csvFiles = await ecforce.downloadCsvs(startDate, endDate);
    } catch (err) {
      if (err.message === '2FA_REQUIRED') {
        console.error('2段階認証が必要です。Chatworkに通知します。');
        await chatwork.notify2FA();
        process.exit(1);
      }
      throw err;
    }

    if (csvFiles.length === 0) {
      throw new Error('CSVファイルがダウンロードされませんでした');
    }

    // Step 3: Import CSVs to Google Sheets
    console.log('\n■ ステップ3: Google Sheetsにインポート');
    const importResults = await sheets.importAllCsvs(csvFiles);
    console.log('インポート結果:', importResults);

    // Step 4: Verify
    console.log('\n■ ステップ4: 検証');
    // Wait a moment for Sheets to recalculate formulas
    await new Promise(r => setTimeout(r, 5000));
    const verification = await sheets.verify(startDate, endDate);
    console.log(`検証結果: ${verification}`);

    // Step 5: Notify via Chatwork
    console.log('\n■ ステップ5: 結果通知');
    await chatwork.notifySuccess({
      period: periodStr,
      imported: importResults,
      verification,
    });

    console.log('\n===== 完了 =====');

  } catch (error) {
    console.error('\n===== エラー =====');
    console.error(error);
    await chatwork.notifyError(error).catch(e => console.error('Chatwork通知も失敗:', e));
    process.exit(1);
  }
}

main();
