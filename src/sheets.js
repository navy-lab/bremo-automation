const { google } = require('googleapis');
const fs = require('fs');
const iconv = require('iconv-lite');
const config = require('./config');

function getAuth() {
  const credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS);
  return new google.auth.GoogleAuth({
    credentials,
    scopes: [
      'https://www.googleapis.com/auth/spreadsheets',
    ],
  });
}

function getMonthlySheetName(date) {
  return `${date.getFullYear()}_${date.getMonth() + 1}月`;
}

// 0-based 列インデックス → A1 列名 (14 -> "O")
function colLetter(index) {
  let n = index;
  let s = '';
  do {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return s;
}

function yesterdayJST() {
  const now = new Date();
  const jstOffset = 9 * 60 * 60 * 1000;
  const jst = new Date(now.getTime() + jstOffset);
  jst.setUTCDate(jst.getUTCDate() - 1);
  return new Date(jst.getUTCFullYear(), jst.getUTCMonth(), jst.getUTCDate());
}

function todayJST() {
  const now = new Date();
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  return new Date(jst.getUTCFullYear(), jst.getUTCMonth(), jst.getUTCDate());
}

function formatDate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}/${m}/${d}`;
}

// ec_* タブの日付セルから YYYY-MM-DD を抽出。
// A列(集計期間 "2026-06-04 ... - 2026-06-05 ...")でもB列(実日付 "2026/06/05")でも拾えるよう
// ハイフン/スラッシュ両対応。判定はB列(実日付)で行う運用に変更したため両形式を許容する(2026-06)。
function parseEcDate(s) {
  if (s === null || s === undefined) return null;
  const m = String(s).match(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

// ===== Determine last imported date from the ec_* destination tabs =====
// 月次シートに依存せず、自分が書き込む先(ec_*タブ)の最終日付を真実の源とする。
// 判定はB列(実日付)で行う。A列はecforceの「集計期間」文字列で、複数日まとめ取得時に
// 「開始日」しか拾えず最終取込日を誤認→境界日の二重取込を招いていたため(2026-06修正)。
async function getLastImportedDate(sheets) {
  const perTabMax = [];
  for (const group of config.AD_GROUPS) {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: config.SPREADSHEET_ID,
      range: `'${group.tab}'!A2:B`,
    }).catch(() => ({ data: { values: [] } }));
    const dates = (res.data.values || [])
      .map(r => parseEcDate(r[config.CSV_DATE_COL_INDEX]))
      .filter(Boolean);
    if (dates.length === 0) { perTabMax.push(null); continue; }
    perTabMax.push(dates.reduce((a, b) => (b > a ? b : a)));
  }
  const nonNull = perTabMax.filter(Boolean);
  if (nonNull.length === 0) return null; // 全タブ空（初回）
  // どれか1タブでも遅れている場合に取りこぼさないよう、各タブ最終日の「最小」を採用
  return nonNull.reduce((a, b) => (b < a ? b : a));
}

async function getLastDataDate() {
  // Manual override
  if (process.env.START_DATE) {
    const start = new Date(process.env.START_DATE);
    const end = process.env.END_DATE ? new Date(process.env.END_DATE) : yesterdayJST();
    return { startDate: start, endDate: end };
  }

  const auth = getAuth();
  const sheets = google.sheets({ version: 'v4', auth });
  const yd = yesterdayJST();

  const lastImported = await getLastImportedDate(sheets);

  if (!lastImported) {
    // ec_*タブにデータなし（初回）→ 昨日の属する月の1日から
    const startDate = new Date(yd.getFullYear(), yd.getMonth(), 1);
    console.log('ec_*タブにデータが無いため月初から取得します');
    return { startDate, endDate: yd };
  }

  const startDate = new Date(lastImported);
  startDate.setDate(startDate.getDate() + 1);
  const endDate = yd;

  console.log(`最終取込日(ec_*基準): ${formatDate(lastImported)}`);
  console.log(`取得対象期間: ${formatDate(startDate)} 〜 ${formatDate(endDate)}`);

  if (startDate > endDate) {
    return null; // 取得不要
  }

  return { startDate, endDate };
}

// ===== 月次シートの自動生成 =====
// 当月(today JST)の月次シートが無ければ前月シートを複製し、基準日セル(B10既定)を当月1日に設定。
// 他の日付/曜日はB11=B10+1...の数式で自動更新される（手作業手順を自動化）。
// importerはec_*基準になったため、本処理が失敗してもデータ取込自体は止まらない（呼び出し側でnon-fatal扱い）。
async function ensureMonthlySheet() {
  const auth = getAuth();
  const sheets = google.sheets({ version: 'v4', auth });

  const today = todayJST();
  const targetName = getMonthlySheetName(today);

  const meta = await sheets.spreadsheets.get({
    spreadsheetId: config.SPREADSHEET_ID,
    fields: 'sheets.properties(sheetId,title,index)',
  });
  const props = meta.data.sheets.map(s => s.properties);

  if (props.some(p => p.title === targetName)) {
    console.log(`月次シート ${targetName} は既に存在`);
    return;
  }

  const prev = new Date(today.getFullYear(), today.getMonth() - 1, 1);
  const prevName = getMonthlySheetName(prev);
  const prevSheet = props.find(p => p.title === prevName);
  if (!prevSheet) {
    console.log(`前月シート ${prevName} が見つからないため月次シート自動生成をスキップ`);
    return;
  }

  console.log(`月次シート ${targetName} を ${prevName} から自動生成します`);
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: config.SPREADSHEET_ID,
    requestBody: {
      requests: [{
        duplicateSheet: {
          sourceSheetId: prevSheet.sheetId,
          insertSheetIndex: prevSheet.index + 1,
          newSheetName: targetName,
        },
      }],
    },
  });

  const baseCell = config.MONTH_BASE_DATE_CELL || 'B10';
  const baseDate = formatDate(new Date(today.getFullYear(), today.getMonth(), 1));
  await sheets.spreadsheets.values.update({
    spreadsheetId: config.SPREADSHEET_ID,
    range: `'${targetName}'!${baseCell}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [[baseDate]] },
  });

  console.log(`月次シート ${targetName} 生成完了（基準日 ${baseCell}=${baseDate}）`);
}

// ===== Parse CSV (Shift_JIS) =====
function parseCsvSimple(filePath) {
  const buffer = fs.readFileSync(filePath);
  const text = iconv.decode(buffer, 'Shift_JIS');

  const rows = [];
  const lines = text.split(/\r?\n/);

  for (const line of lines) {
    if (line.trim() === '') continue;

    const fields = [];
    let current = '';
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQuotes && line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (ch === ',' && !inQuotes) {
        fields.push(current);
        current = '';
      } else {
        current += ch;
      }
    }
    fields.push(current);
    rows.push(fields);
  }

  return rows;
}

async function importCsvToSheet(csvFile) {
  const auth = getAuth();
  const sheets = google.sheets({ version: 'v4', auth });

  const { group, filePath } = csvFile;
  const tabName = group.tab;

  console.log(`  ${group.name} → ${tabName} にインポート中...`);

  // Parse CSV
  const rows = parseCsvSimple(filePath);
  if (rows.length <= 1) {
    console.log(`  データ行なし（ヘッダーのみ）`);
    return 0;
  }

  // 既存データ（B列=実日付）を取得して重複判定に使う。
  // A列(集計期間)ではなくB列(実日付)で判定する点が重要（2026-06の二重取込修正）。
  const existing = await sheets.spreadsheets.values.get({
    spreadsheetId: config.SPREADSHEET_ID,
    range: `'${tabName}'!A2:B`,
  }).catch(() => ({ data: { values: [] } }));

  const existingRows = existing.data.values || [];
  const hasExistingData = existingRows.length > 0;
  const existingDates = new Set(
    existingRows.map(r => { const d = parseEcDate(r[config.CSV_DATE_COL_INDEX]); return d ? formatDate(d) : null; }).filter(Boolean)
  );

  // 既存データありならヘッダー行をスキップ
  let dataRows = hasExistingData ? rows.slice(config.CSV_HEADER_ROWS || 1) : rows;

  // 冪等化: 既にその日付がタブに存在する行は取り込まない（手動再実行での二重取込を防止）
  if (hasExistingData && existingDates.size > 0) {
    const before = dataRows.length;
    dataRows = dataRows.filter(r => {
      const d = parseEcDate(r[config.CSV_DATE_COL_INDEX]);
      return d ? !existingDates.has(formatDate(d)) : true;
    });
    const skipped = before - dataRows.length;
    if (skipped > 0) console.log(`  既存日付の${skipped}行をスキップ（冪等化）`);
  }

  if (dataRows.length === 0) {
    console.log(`  追記対象の新規データなし`);
    return 0;
  }

  // 末尾に追記
  await sheets.spreadsheets.values.append({
    spreadsheetId: config.SPREADSHEET_ID,
    range: `'${tabName}'!A1`,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: {
      values: dataRows,
    },
  });

  const rowCount = hasExistingData ? dataRows.length : dataRows.length - (config.CSV_HEADER_ROWS || 1);
  console.log(`  ${rowCount}行インポート完了`);
  return rowCount;
}

// ===== Import all CSVs =====
async function importAllCsvs(csvFiles) {
  const results = [];

  for (const csvFile of csvFiles) {
    const rowCount = await importCsvToSheet(csvFile);
    results.push(`${csvFile.group.name}: ${rowCount}行`);
  }

  return results;
}

// ===== Verify by checking LP access column =====
async function verify(startDate, endDate) {
  const auth = getAuth();
  const sheets = google.sheets({ version: 'v4', auth });

  const sheetName = getMonthlySheetName(endDate);
  const lpCol = colLetter(config.LP_ACCESS_COL_INDEX);
  const offset = (config.DAY_ROW_OFFSET != null) ? config.DAY_ROW_OFFSET : 9;

  // day N = 行(OFFSET + N)
  const startDay = startDate.getDate();
  const endDay = endDate.getDate();
  const startRow = offset + startDay;
  const endRow = offset + endDay;

  const range = `'${sheetName}'!${lpCol}${startRow}:${lpCol}${endRow}`;

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: config.SPREADSHEET_ID,
    range,
    valueRenderOption: 'UNFORMATTED_VALUE',
  });

  const values = res.data.values || [];
  const results = [];
  let allNonZero = true;

  for (let i = 0; i < values.length; i++) {
    const day = startDay + i;
    const val = values[i] && values[i][0] ? Number(values[i][0]) : 0;
    const dateStr = `${endDate.getMonth() + 1}/${day}`;
    results.push(`${dateStr}: ${val}`);
    if (val === 0) allNonZero = false;
  }

  if (allNonZero && values.length > 0) {
    return `✓ 全日付のLPアクセス数が反映されました (${results.join(', ')})`;
  } else {
    return `△ 一部の日付でLPアクセス数が0です (${results.join(', ')})`;
  }
}

module.exports = { getLastDataDate, ensureMonthlySheet, importAllCsvs, verify, yesterdayJST, formatDate };
