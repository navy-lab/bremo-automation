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

function yesterdayJST() {
  const now = new Date();
  // Convert to JST
  const jstOffset = 9 * 60 * 60 * 1000;
  const jst = new Date(now.getTime() + jstOffset);
  jst.setUTCDate(jst.getUTCDate() - 1);
  return new Date(jst.getUTCFullYear(), jst.getUTCMonth(), jst.getUTCDate());
}

function formatDate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}/${m}/${d}`;
}

// ===== Check last data date from O column =====
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
  const sheetName = getMonthlySheetName(yd);
  console.log(`当月シート: ${sheetName}`);

  // Read rows 10-40 (day 1=row10, day 31=row40 based on the sheet structure)
  // Actually, based on the screenshot: row 9 = header "日", row 10 = 3/1, row 11 = 3/2, etc.
  // So day N is at row (9 + N)
  // O column = column 15 = index 14 in 0-based
  const range = `'${sheetName}'!A10:O40`;

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: config.SPREADSHEET_ID,
    range,
    valueRenderOption: 'UNFORMATTED_VALUE',
  });

  const rows = res.data.values || [];
  let lastDataRow = -1;

  // Find the last row where O column (index 14) has a non-zero value
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i];
    if (row && row.length > config.LP_ACCESS_COL_INDEX) {
      const lpAccess = row[config.LP_ACCESS_COL_INDEX];
      if (lpAccess && lpAccess !== 0 && lpAccess !== '' && !isNaN(Number(lpAccess)) && Number(lpAccess) > 0) {
        lastDataRow = i;
        break;
      }
    }
  }

  if (lastDataRow === -1) {
    // No data at all, start from day 1
    const startDate = new Date(yd.getFullYear(), yd.getMonth(), 1);
    return { startDate, endDate: yd };
  }

  // Row index in our data = day of month - 1 (row 0 = day 1)
  // The B column (index 1) should have the date like "3/25"
  const lastDataDay = lastDataRow + 1; // day of month
  const lastDataDate = new Date(yd.getFullYear(), yd.getMonth(), lastDataDay);

  const startDate = new Date(lastDataDate);
  startDate.setDate(startDate.getDate() + 1);
  const endDate = yd;

  console.log(`最終データ日: ${lastDataDay}日 (O列にデータあり)`);
  console.log(`取得対象期間: ${formatDate(startDate)} 〜 ${formatDate(endDate)}`);

  if (startDate > endDate) {
    return null; // No data to fetch
  }

  return { startDate, endDate };
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

  // Check if the tab already has data
  const existingData = await sheets.spreadsheets.values.get({
    spreadsheetId: config.SPREADSHEET_ID,
    range: `'${tabName}'!A1:A1`,
  }).catch(() => ({ data: { values: [] } }));

  const hasExistingData = existingData.data.values && existingData.data.values.length > 0;

  // Prepare data rows (skip header if sheet already has data)
  const dataRows = hasExistingData ? rows.slice(1) : rows;

  if (dataRows.length === 0) {
    console.log(`  データ行なし`);
    return 0;
  }

  // Append to sheet
  await sheets.spreadsheets.values.append({
    spreadsheetId: config.SPREADSHEET_ID,
    range: `'${tabName}'!A1`,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: {
      values: dataRows,
    },
  });

  const rowCount = hasExistingData ? dataRows.length : dataRows.length - 1;
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

// ===== Verify by checking O column =====
async function verify(startDate, endDate) {
  const auth = getAuth();
  const sheets = google.sheets({ version: 'v4', auth });

  const sheetName = getMonthlySheetName(endDate);

  // Read O column for the date range
  // Day N = row (9 + N)
  const startDay = startDate.getDate();
  const endDay = endDate.getDate();
  const startRow = 9 + startDay;
  const endRow = 9 + endDay;

  const range = `'${sheetName}'!O${startRow}:O${endRow}`;

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

module.exports = { getLastDataDate, importAllCsvs, verify, yesterdayJST, formatDate };
