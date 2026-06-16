const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const config = require('./config');

function formatDateForEcforce(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function buildSearchUrl(groupId, startDate, endDate) {
  const startStr = `${formatDateForEcforce(startDate)} 00:00:00 +0900`;
  const endStr = `${formatDateForEcforce(endDate)} 23:59:59 +0900`;

  const params = new URLSearchParams();
  params.append('utf8', '✓');
  params.append('group_by', 'daily');
  params.append('q[url_url_group_id_in][]', '');
  params.append('q[url_url_group_id_in][]', groupId);
  params.append('q[url_id_in][]', '');
  params.append('relative_date', 'on');
  params.append('s_month', '');
  params.append('e_month', '');
  params.append('q[created_at_gteq]', startStr);
  params.append('q[created_at_lt]', endStr);
  params.append('button', '');

  return `${config.ECFORCE.BASE_URL}/advertiser/advertisements?${params.toString()}`;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ===== Login (1試行分) =====
// ca-now.jp は朝7-8時台にログインページがフォームを返さないことが間欠的にある
// (2026-06-04 / 06-05 / 06-11 に発生)。networkidle待ちは非致命化し、
// フォーム出現は waitFor で明示的に待つ。
async function login(page) {
  // Fill login form
  const emailInput = page.locator('input[type="email"], input[name*="email"], #advertiser_email').first();
  const passwordInput = page.locator('input[type="password"], input[name*="password"], #advertiser_password').first();

  // ca-now.jp は朝方、ログインフォームを返さない（メンテ/エラー/未完成HTMLを返す）ことが間欠的にある。
  // 旧実装は goto 1回＋45秒待ちのみで、フォーム不在ページが返ると45秒空費して即失敗していた。
  // 1試行の中でも goto→フォーム出現待ちを最大3回リロードして粘り、短時間の不応答を吸収する。
  let formReady = false;
  for (let pass = 1; pass <= 3 && !formReady; pass++) {
    try {
      await page.goto(`${config.ECFORCE.BASE_URL}/advertisers/sign_in`, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
      await emailInput.waitFor({ state: 'visible', timeout: 20000 });
      formReady = true;
    } catch (e) {
      const head = (e.message || String(e)).split('\n')[0];
      console.error(`  ログインフォーム未出現 (リロード ${pass}/3): ${head}`);
      if (pass < 3) await sleep(5000);
    }
  }
  if (!formReady) {
    await page.screenshot({ path: path.join(config.SCREENSHOT_DIR, 'login-form-not-found.png'), fullPage: true }).catch(() => {});
    throw new Error('LOGIN_FORM_NOT_FOUND');
  }

  await emailInput.fill(config.ECFORCE.EMAIL);
  await passwordInput.fill(config.ECFORCE.PASSWORD);

  // Click login button
  await page.locator('button:has-text("Start"), input[type="submit"]').first().click();
  await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
  await sleep(2000);

  // Check for 2FA
  const currentUrl = page.url();
  const pageContent = await page.textContent('body');

  if (pageContent.includes('認証コード') || pageContent.includes('ワンタイム') ||
      pageContent.includes('二段階') || pageContent.includes('2段階') ||
      currentUrl.includes('otp') || currentUrl.includes('two_factor')) {
    console.error('2段階認証が検出されました');
    await page.screenshot({ path: path.join(config.SCREENSHOT_DIR, '2fa-detected.png') });
    throw new Error('2FA_REQUIRED');
  }

  // Verify login success
  if (currentUrl.includes('sign_in')) {
    console.error('ログイン失敗');
    await page.screenshot({ path: path.join(config.SCREENSHOT_DIR, 'login-failed.png') });
    throw new Error('LOGIN_FAILED');
  }

  console.log('ログイン成功');
}

// ===== Login with retry（時間予算ベース）=====
// ca-now.jp は朝7:30-8:30台にログインフォームを数分間返さないことが間欠的にある
// (2026-06-04/05/11/15/16 に発生。6/16は08:29-08:33の約4.5分間ずっと不応答だった)。
// 旧実装は「2試行・合計約4.5分」で見切っており、不応答が"継続している最中"に諦めて失敗していた。
// → 単一Runが朝の不応答を"待ち切れる"よう、最大18分の時間予算で粘る（GitHubのcron遅延で
//   不応答窓に着弾しても、窓が空くまで再試行し続けて同一Run内で取り戻す）。
// 2FA要求はリトライで解消しないため即座に投げ直す。各試行の失敗時はスクショをartifactに残す。
async function loginWithRetry(page, { maxMs = 18 * 60 * 1000, waitMs = 60000 } = {}) {
  const start = Date.now();
  let attempt = 0;
  let lastErr;
  while (true) {
    attempt++;
    const elapsed = () => Math.round((Date.now() - start) / 1000);
    try {
      console.log(`ecforceにログイン中... (試行 ${attempt}, 経過 ${elapsed()}s / 予算 ${Math.round(maxMs / 1000)}s)`);
      await login(page);
      return;
    } catch (e) {
      if (e.message === '2FA_REQUIRED') throw e;
      lastErr = e;
      const headline = e.message ? e.message.split('\n')[0] : String(e);
      console.error(`ログイン試行 ${attempt} 失敗 (経過 ${elapsed()}s): ${headline}`);
      await page.screenshot({ path: path.join(config.SCREENSHOT_DIR, `login-attempt-${attempt}-failed.png`), fullPage: true }).catch(() => {});
      // 次の待機を挟むと予算を超えるなら、これ以上粘らず終了する
      if (Date.now() - start + waitMs >= maxMs) {
        // 時間予算を使い切ってのログイン不能 = ca-now.jp側の"継続的な"不応答とみなし、
        // 呼び出し側(index.js)で「スロットに応じた通知抑制」の対象にできるようフラグを立てる。
        lastErr.isEcforceUnreachable = true;
        console.error(`ログイン時間予算(${Math.round(maxMs / 1000)}s)を使い切りました。ca-now.jpの不応答が継続している可能性が高いです。`);
        throw lastErr;
      }
      console.log(`${waitMs / 1000}秒待機して再試行します（ecforce側の朝の不応答を待ち切る）`);
      await sleep(waitMs);
    }
  }
}

async function downloadCsvs(startDate, endDate) {
  fs.mkdirSync(config.DOWNLOAD_DIR, { recursive: true });
  fs.mkdirSync(config.SCREENSHOT_DIR, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    acceptDownloads: true,
    locale: 'ja-JP',
    timezoneId: 'Asia/Tokyo',
  });
  const page = await context.newPage();

  // Auto-accept confirm dialogs
  page.on('dialog', async dialog => {
    console.log(`  ダイアログ検出: ${dialog.message().substring(0, 50)}...`);
    await dialog.accept();
  });

  const downloadedFiles = [];

  try {
    // ===== Login (リトライ付き) =====
    await loginWithRetry(page);

    // ===== Download CSVs for each group =====
    const dateTag = formatDateForEcforce(startDate) === formatDateForEcforce(endDate)
      ? formatDateForEcforce(startDate).replace(/-/g, '')
      : `${formatDateForEcforce(startDate).replace(/-/g, '')}-${formatDateForEcforce(endDate).replace(/-/g, '')}`;

    for (const group of config.AD_GROUPS) {
      console.log(`\n--- ${group.name} (ID: ${group.ecforceId}) ---`);

      // Navigate directly to the search results URL
      const searchUrl = buildSearchUrl(group.ecforceId, startDate, endDate);
      console.log('  検索URL生成完了');

      await page.goto(searchUrl);
      await page.waitForLoadState('networkidle');
      await sleep(2000);

      // Verify the date range is correct
      const periodText = await page.locator('td:has-text("2026")').first().textContent().catch(() => '');
      console.log(`  表示期間: ${periodText.substring(0, 50)}`);

      // Check "検索結果すべてを処理対象にする"
      const selectAllCheckbox = page.locator('input[type="checkbox"]').filter({ has: page.locator('..', { hasText: '検索結果すべてを処理対象にする' }) });

      // Try multiple selectors for the checkbox
      let checked = false;
      const checkboxSelectors = [
        'text=検索結果すべてを処理対象にする',
        'label:has-text("検索結果すべてを処理対象にする")',
      ];

      for (const selector of checkboxSelectors) {
        const el = page.locator(selector);
        if (await el.count() > 0) {
          await el.click();
          checked = true;
          console.log('  「検索結果すべてを処理対象にする」チェック完了');
          break;
        }
      }

      if (!checked) {
        // Try clicking the checkbox directly near the text
        const checkboxNearText = page.locator('input[type="checkbox"]').first();
        if (await checkboxNearText.count() > 0) {
          // Find the one near "検索結果"
          const allCheckboxes = await page.locator('input[type="checkbox"]').all();
          for (const cb of allCheckboxes) {
            const parent = await cb.evaluate(el => el.parentElement?.textContent || '');
            if (parent.includes('検索結果')) {
              await cb.click();
              checked = true;
              console.log('  チェックボックス検出・チェック完了');
              break;
            }
          }
        }
      }

      await sleep(500);

      // Click "CSV 一括出力" and wait for download
      // The CSV button on ecforce is a plain text link, not a <button>
      // Use XPath to find the exact visible text element
      let csvButton = null;
      const csvCandidates = await page.locator(':visible:text("CSV")').all();
      for (const el of csvCandidates) {
        const text = await el.textContent().catch(() => '');
        if (text.includes('CSV') && text.includes('一括出力')) {
          csvButton = el;
          console.log(`  CSV出力ボタン検出: "${text.trim()}"`);
          break;
        }
      }

      if (!csvButton) {
        // Fallback: try clicking by exact visible text
        const fallback = page.locator('text=/CSV.*一括出力/');
        if (await fallback.count() > 0) {
          csvButton = fallback.first();
          console.log('  CSV出力ボタン検出（フォールバック）');
        }
      }

      if (!csvButton) {
        console.log(`  警告: CSV出力ボタンが見つかりません（${group.name}）`);
        await page.screenshot({ path: path.join(config.SCREENSHOT_DIR, `no-csv-button-${group.name}.png`), fullPage: true });
        continue;
      }

      const [download] = await Promise.all([
        page.waitForEvent('download', { timeout: 30000 }),
        csvButton.click(),
      ]);

      // Save the downloaded file with the correct name
      const fileName = `${group.name}_${dateTag}.csv`;
      const filePath = path.join(config.DOWNLOAD_DIR, fileName);
      await download.saveAs(filePath);

      console.log(`  ダウンロード完了: ${fileName}`);
      downloadedFiles.push({ group, filePath, fileName });

      await sleep(1000);
    }

    console.log(`\n全グループのCSVダウンロード完了 (${downloadedFiles.length}件)`);

  } finally {
    await browser.close();
  }

  return downloadedFiles;
}

module.exports = { downloadCsvs };
