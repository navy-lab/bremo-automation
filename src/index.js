const ecforce = require('./ecforce');
const sheets = require('./sheets');
const chatwork = require('./chatwork');
const config = require('./config');

async function main() {
  console.log('===== Bremo デイレポ自動更新 =====');
  console.log(`実行日時: ${new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })}`);

  // 失敗時の通知エスカレーション判定に使うため、取得対象期間をcatchからも参照できるよう外で保持
  let fetchRange = null;

  try {
    // Step 0: 当月の月次シートを用意（無ければ前月複製＋基準日セット）
    // ※importerはec_*基準で月次シート非依存のため、ここが失敗しても取込は止めない
    console.log('\n■ ステップ0: 月次シートの確認・自動生成');
    try {
      await sheets.ensureMonthlySheet();
    } catch (e) {
      console.error('月次シート自動生成でエラー（取込は継続します）:', e.message || e);
    }

    // Step 1: Check last data date
    console.log('\n■ ステップ1: 最終データ日の確認');
    const dateRange = await sheets.getLastDataDate();

    if (!dateRange) {
      console.log('取得すべきデータなし（昨日分まで反映済み）');
      // リカバリ枠cron(朝07:00以外)では「取込済み」が正常状態なので通知しない
      // （毎日「取得不要」通知が2通飛ぶノイズを防止。TRIGGER_SCHEDULEはworkflowのgithub.event.schedule）
      const sched = process.env.TRIGGER_SCHEDULE || '';
      if (sched && sched !== config.SCHEDULES.PRIMARY) {
        console.log(`リカバリ枠(cron: ${sched})のため通知はスキップ`);
        return;
      }
      await chatwork.notifyNoData();
      return;
    }

    const { startDate, endDate } = dateRange;
    fetchRange = dateRange;
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
      const e = new Error('CSVファイルがダウンロードされませんでした');
      e.isEcforceUnreachable = true; // ca-now.jp側でCSVが取れない=朝方不応答と同類。リカバリ枠で取り戻す
      throw e;
    }

    // Step 3: Import CSVs to Google Sheets
    console.log('\n■ ステップ3: Google Sheetsにインポート');
    const importResults = await sheets.importAllCsvs(csvFiles);
    console.log('インポート結果:', importResults);

    // Step 4: Verify（参考情報。月次シート依存のため失敗してもエラーにしない）
    console.log('\n■ ステップ4: 検証');
    // Wait a moment for Sheets to recalculate formulas
    await new Promise(r => setTimeout(r, 5000));
    let verification;
    try {
      verification = await sheets.verify(startDate, endDate);
    } catch (e) {
      verification = `（検証スキップ: ${e.message || e}）`;
    }
    console.log(`検証結果: ${verification}`);

    // Step 5: Notify via Chatwork
    console.log('\n■ ステップ5: 結果通知');
    const trigSched = process.env.TRIGGER_SCHEDULE || '';
    await chatwork.notifySuccess({
      period: periodStr,
      imported: importResults,
      verification,
      // プライマリ以外で実データを取得した = 朝の取得が遅延/失敗しリカバリ枠で補完したケース
      isRecovery: trigSched !== '' && trigSched !== config.SCHEDULES.PRIMARY,
    });

    console.log('\n===== 完了 =====');

  } catch (error) {
    console.error('\n===== エラー =====');
    console.error(error);

    // 通知エスカレーション:
    // ca-now.jp の朝方不応答は後続のリカバリ枠(cron)で自動的に取り戻せるため、
    // プライマリ/早朝リカバリ枠での失敗は「想定内・自己回復見込み」として通知を抑制する。
    // 本当に人手対応が要るのは「10時watchdog/14時最終枠でも失敗」か「取りこぼしが2日分以上累積」のとき。
    const sched = process.env.TRIGGER_SCHEDULE || '';
    const isManual = sched === '';
    const isWatchdog = sched === config.SCHEDULES.WATCHDOG; // 10:03 JST: ここで未取込なら1通だけ警報
    const isFinalSlot = sched === config.SCHEDULES.FINAL;   // 14:07 JST: 当日最終枠
    // 取得対象が2日分以上 = 過去の取りこぼしが累積している → スロットに関係なく警報
    let daysBehind = 1;
    if (fetchRange && fetchRange.startDate && fetchRange.endDate) {
      daysBehind = Math.round((fetchRange.endDate - fetchRange.startDate) / 86400000) + 1;
    }
    const criticalStale = daysBehind >= 2;
    // ca-now.jp由来の一時的失敗(ログイン不能/CSV取得不可)は後続枠での自己回復を見込み、
    // プライマリ/早朝リカバリ枠では通知を抑制する。人手確認が要るのは次のときだけ:
    //   ・10:03 watchdog枠でもまだ取れない（朝が回復していない＝沈黙放置を防ぐ1通の安全網）
    //   ・14:07 最終枠でも取れない（朝〜午後を通して失敗）
    //   ・取りこぼしが2日分以上累積 / 手動実行 / 想定外エラー(Sheets権限等)
    const isTransient = !!(error && error.isEcforceUnreachable);
    const shouldAlert = !isTransient || isManual || isWatchdog || isFinalSlot || criticalStale;

    if (shouldAlert) {
      await chatwork.notifyError(error, { daysBehind, isWatchdog, isFinalSlot, criticalStale })
        .catch(e => console.error('Chatwork通知も失敗:', e));
      process.exit(1);
    } else {
      console.log(`[通知抑制] ${sched || '手動'}枠での失敗。後続のリカバリ枠で自動再取得します（未取込 ${daysBehind} 日分のため非警報）。`);
      // ジョブも失敗させない(exit 0)。Chatworkは抑制してもジョブがfailだとGitHubの
      // "Run failed" メールが毎朝飛び、自己回復する一時不応答が本物の障害と区別できなくなるため。
      // 未取込のままなら 10:03 watchdog / 14:07 最終枠が exit 1 + Chatwork警報で必ず顕在化する。
      console.log(`::warning::ecforce一時不応答のためこの枠はスキップ（後続リカバリ枠で自動再取得・未取込${daysBehind}日分）`);
      process.exit(0);
    }
  }
}

main();
