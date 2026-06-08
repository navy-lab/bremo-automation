// ===== ec_* タブの重複行クリーンアップ（ワンショット） =====
// 2026-06の二重取込バグで ec_* タブに「実日付(B列)+デバイス(C列)」が同じ行が
// 二重に追記された。本スクリプトは各 ec_* タブを走査し、(実日付+デバイス)が
// 既出の行（=2つ目以降）を deleteDimension で物理削除する。最初の出現は残す。
// index.js と同じサービスアカウント(GOOGLE_CREDENTIALS)で実行する。
// 使い捨て: 実行・確認後に dedup.js / dedup.yml は削除してよい。
const { google } = require('googleapis');
const config = require('./config');

function getAuth() {
  const credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS);
  return new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
}

// "2026-06-05 ..." / "2026/06/05" 双方から YYYY/MM/DD を返す
function normDate(s) {
  if (s === null || s === undefined) return null;
  const m = String(s).match(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (!m) return null;
  return `${m[1]}/${('0' + m[2]).slice(-2)}/${('0' + m[3]).slice(-2)}`;
}

async function main() {
  const auth = getAuth();
  const sheets = google.sheets({ version: 'v4', auth });

  const meta = await sheets.spreadsheets.get({
    spreadsheetId: config.SPREADSHEET_ID,
    fields: 'sheets.properties(sheetId,title)',
  });
  const idByTitle = {};
  meta.data.sheets.forEach(s => { idByTitle[s.properties.title] = s.properties.sheetId; });

  const DATE_COL = config.CSV_DATE_COL_INDEX; // 1 = B列(実日付)
  const DEVICE_COL = 2; // C列(デバイス: 合計/PC/SP/その他)

  for (const group of config.AD_GROUPS) {
    const tab = group.tab;
    const sheetId = idByTitle[tab];
    if (sheetId === undefined) { console.log(`${tab}: タブ未検出（スキップ）`); continue; }

    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: config.SPREADSHEET_ID,
      range: `'${tab}'!A1:C`,
    });
    const rows = res.data.values || [];

    const seen = new Set();
    const dupIdx = []; // 0-based シート行インデックス
    for (let i = 0; i < rows.length; i++) {
      const d = normDate(rows[i][DATE_COL]);
      if (!d) continue; // ヘッダー/空行はキー対象外＝残す
      const device = (rows[i][DEVICE_COL] || '').trim();
      const key = `${d}|${device}`;
      if (seen.has(key)) dupIdx.push(i);
      else seen.add(key);
    }

    if (dupIdx.length === 0) { console.log(`${tab}: 重複なし`); continue; }

    // 後ろから削除（インデックスずれ防止）
    dupIdx.sort((a, b) => b - a);
    const requests = dupIdx.map(i => ({
      deleteDimension: { range: { sheetId, dimension: 'ROWS', startIndex: i, endIndex: i + 1 } },
    }));
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: config.SPREADSHEET_ID,
      requestBody: { requests },
    });
    const human = dupIdx.slice().sort((a, b) => a - b).map(i => i + 1); // 1-based 行番号
    console.log(`${tab}: ${dupIdx.length}行削除（行番号: ${human.join(', ')}）`);
  }
  console.log('===== dedup 完了 =====');
}

main().catch(e => { console.error(e); process.exit(1); });
