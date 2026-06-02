const path = require('path');

module.exports = {
  AD_GROUPS: [
    { name: 'G_一般', tab: 'ec_G一般KW', ecforceId: '58' },
    { name: 'G_指名', tab: 'ec_G指名KW', ecforceId: '60' },
    { name: 'Y_一般', tab: 'ec_Y一般KW', ecforceId: '59' },
    { name: 'Y_指名', tab: 'ec_Y指名KW', ecforceId: '61' },
  ],
  SPREADSHEET_ID: '1sZKBgAa2iDGdQ3rBNAJ9QnFnbAkKqJF74THxJ0vsr8I',
  ECFORCE: {
    BASE_URL: 'https://ca-now.jp',
    EMAIL: process.env.ECFORCE_EMAIL || 'navy@symbe.co.jp',
    PASSWORD: process.env.ECFORCE_PASSWORD || 'canow1234',
  },
  CHATWORK: {
    API_TOKEN: process.env.CHATWORK_API_TOKEN || '1961ab94b73bd52cfb2d433c9aaf8cd5',
    ROOM_ID: process.env.CHATWORK_ROOM_ID || '429157045',
  },
  DOWNLOAD_DIR: path.join(__dirname, '..', 'downloads'),
  SCREENSHOT_DIR: path.join(__dirname, '..', 'screenshots'),
  LP_ACCESS_COL_INDEX: 14, // O column (0-based in values array)
  CSV_DATE_COL_INDEX: 1,   // B column in CSV
  // 月次シート: row9=ヘッダー, 1日=行10。verify用オフセット。
  DAY_ROW_OFFSET: 9,
  // 月次シート自動生成時に当月1日をセットする基準日セル(B10=直接値, B11=B10+1...)。
  MONTH_BASE_DATE_CELL: 'B10',
};
