const puppeteer = require('puppeteer');
const { DateTime } = require('luxon');
const { InfluxDB, Point } = require('@influxdata/influxdb-client');
const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');

require('dotenv').config();

var korpelaurl = "https://omakorpela.korpelanvoima.fi/login";
const verboseLogging = process.env.KORPELA_VERBOSE === '1';
const maxRetryAttempts = Number(process.env.KORPELA_FETCH_RETRIES || 2);

function normalizeHeader(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/g, '');
}

function parseTimestamp(value) {
  if (!value) return null;

  if (value instanceof Date) {
    return DateTime.fromJSDate(value).toUTC();
  }

  if (typeof value === 'number') {
    // Excel serial date to JS date conversion
    const parsed = XLSX.SSF.parse_date_code(value);
    if (!parsed) return null;
    return DateTime.utc(parsed.y, parsed.m, parsed.d, parsed.H, parsed.M, parsed.S);
  }

  const text = String(value).trim();
  const candidates = [
    DateTime.fromISO(text, { zone: 'Europe/Helsinki' }),
    DateTime.fromFormat(text, 'd.M.yyyy H:mm', { zone: 'Europe/Helsinki' }),
    DateTime.fromFormat(text, 'd.M.yyyy HH:mm', { zone: 'Europe/Helsinki' }),
    DateTime.fromFormat(text, 'd.M.yyyy HH.mm', { zone: 'Europe/Helsinki' }),
    DateTime.fromFormat(text, 'dd.MM.yyyy HH:mm', { zone: 'Europe/Helsinki' }),
    DateTime.fromFormat(text, 'yyyy-MM-dd HH:mm:ss', { zone: 'Europe/Helsinki' }),
  ];

  const dt = candidates.find(item => item.isValid);
  return dt ? dt.toUTC() : null;
}

function parseConsumptionReportXlsx(buffer) {
  const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  const firstSheetName = workbook.SheetNames[0];
  if (!firstSheetName) throw new Error('Excel file has no sheets');

  const sheet = workbook.Sheets[firstSheetName];
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: null, raw: true });
  if (!rows.length) throw new Error('Excel report has no data rows');

  const headers = Object.keys(rows[0]);
  const headerMap = new Map(headers.map(header => [normalizeHeader(header), header]));

  const timestampHeader =
    headerMap.get('aika') ||
    headerMap.get('timestamp') ||
    headerMap.get('datetime') ||
    headerMap.get('alkuaika') ||
    headerMap.get('paivamaaraaika') ||
    headerMap.get('pvmklo');

  const dateHeader =
    headerMap.get('paivamaara') ||
    headerMap.get('pvm') ||
    headerMap.get('date');

  const timeHeader =
    headerMap.get('kellonaika') ||
    headerMap.get('klo') ||
    headerMap.get('time');

  const valueHeader =
    headerMap.get('kulutuskwh') ||
    headerMap.get('kulutus') ||
    headerMap.get('energia') ||
    headerMap.get('kwh') ||
    headerMap.get('consumption') ||
    headerMap.get('usage') ||
    headerMap.get('value');

  if (!valueHeader) throw new Error('Could not identify consumption column from Excel report');
  if (!timestampHeader && !(dateHeader && timeHeader)) {
    throw new Error('Could not identify timestamp column from Excel report');
  }

  const usages = [];

  for (const row of rows) {
    let timestampValue = null;

    if (timestampHeader) {
      timestampValue = row[timestampHeader];
    } else {
      timestampValue = `${row[dateHeader] || ''} ${row[timeHeader] || ''}`.trim();
    }

    const ts = parseTimestamp(timestampValue);
    if (!ts || !ts.isValid) continue;

    const rawValue = row[valueHeader];
    if (rawValue === null || rawValue === undefined || rawValue === '') continue;

    const value = typeof rawValue === 'number'
      ? rawValue
      : parseFloat(String(rawValue).replace(',', '.'));
    if (!Number.isFinite(value)) continue;

    usages.push({
      timestamp: ts.toISO(),
      value: String(value),
    });
  }

  if (!usages.length) throw new Error('Excel report parsed but no valid usage rows were found');

  return {
    data: {
      consumption: {
        usageHistory: {
          usages,
        },
      },
    },
  };
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return 'unknown';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function formatMs(ms) {
  if (!Number.isFinite(ms) || ms < 0) return 'n/a';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

function logTimingSummary(timings) {
  console.log('Timing summary:');
  console.log(` - login+account: ${formatMs(timings.loginAndAccountMs)}`);
  console.log(` - open sales page: ${formatMs(timings.openSalesPageMs)}`);
  console.log(` - quarter selection: ${formatMs(timings.quarterSelectionMs)}`);
  console.log(` - set date: ${formatMs(timings.setDateMs)}`);
  console.log(` - download report: ${formatMs(timings.downloadReportMs)}`);
  console.log(` - parse+save json: ${formatMs(timings.parseAndSaveMs)}`);
  console.log(` - write influx: ${formatMs(timings.writeInfluxMs)}`);
  console.log(` - total: ${formatMs(timings.totalMs)}`);
}

function cleanupExcelFiles(dataDir) {
  const removed = [];
  const files = fs.readdirSync(dataDir);
  for (const fileName of files) {
    if (!/\.xlsx?$/i.test(fileName)) continue;
    const filePath = path.join(dataDir, fileName);
    try {
      fs.unlinkSync(filePath);
      removed.push(fileName);
    } catch (error) {
      console.error(`Failed to remove ${fileName}:`, error.message || error);
    }
  }
  return removed;
}

function dedupeMeasurementData(data) {
  const usages = data?.data?.consumption?.usageHistory?.usages;
  if (!Array.isArray(usages)) {
    return { dedupedData: data, removed: 0 };
  }

  const byTimestamp = new Map();
  for (const usage of usages) {
    if (!usage?.timestamp) continue;
    byTimestamp.set(usage.timestamp, usage);
  }

  const dedupedUsages = Array.from(byTimestamp.values())
    .sort((a, b) => DateTime.fromISO(a.timestamp).toMillis() - DateTime.fromISO(b.timestamp).toMillis());

  const removed = usages.length - dedupedUsages.length;
  return {
    dedupedData: {
      ...data,
      data: {
        ...data.data,
        consumption: {
          ...data.data.consumption,
          usageHistory: {
            ...data.data.consumption.usageHistory,
            usages: dedupedUsages,
          },
        },
      },
    },
    removed,
  };
}

async function waitForDownloadedXlsx(downloadDir, existingFiles, timeoutMs = 45000) {
  const startedAt = Date.now();
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const files = fs.readdirSync(downloadDir);
    const candidate = files
      .filter(name => name.toLowerCase().endsWith('.xlsx'))
      .map(name => path.join(downloadDir, name))
      .find((filePath) => {
        try {
          const stat = fs.statSync(filePath);
          // Accept either a brand new file or an existing file that was modified after click.
          return !existingFiles.has(path.basename(filePath)) || stat.mtimeMs >= startedAt - 200;
        } catch {
          return false;
        }
      });

    if (candidate) {
      // Wait until file size stops changing to avoid reading a partially written download.
      const sizeBefore = fs.statSync(candidate).size;
      await wait(150);
      const sizeAfter = fs.statSync(candidate).size;
      if (sizeAfter !== sizeBefore || sizeAfter === 0) {
        await wait(150);
      }
      return candidate;
    }

    await wait(120);
  }

  return null;
}

async function downloadQuarterHourReport(page) {
  const downloadDir = path.resolve('data');
  fs.mkdirSync(downloadDir, { recursive: true });

  const cdpSession = await page.target().createCDPSession();
  await cdpSession.send('Page.setDownloadBehavior', {
    behavior: 'allow',
    downloadPath: downloadDir,
  });

  const existingFiles = new Set(fs.readdirSync(downloadDir));

  const responsePromise = page.waitForResponse((response) => {
    const headers = response.headers();
    const contentType = (headers['content-type'] || '').toLowerCase();
    const contentDisposition = (headers['content-disposition'] || '').toLowerCase();
    const url = response.url().toLowerCase();
    return (
      (
        contentType.includes('spreadsheetml') ||
        contentType.includes('application/vnd.ms-excel') ||
        contentType.includes('application/octet-stream') ||
        contentDisposition.includes('attachment') ||
        contentDisposition.includes('.xlsx') ||
        url.includes('.xlsx')
      )
    );
  }, { timeout: 45000 });

  const filePromise = waitForDownloadedXlsx(downloadDir, existingFiles, 45000);

  try {
    const clicked = await page.evaluate(() => {
      const allButtons = Array.from(document.querySelectorAll('button, [role="button"]'));
      const normalized = (value) => (value || '').replace(/\s+/g, ' ').trim().toLowerCase();

      const candidate = allButtons.find((btn) => {
        const text = normalized(btn.textContent);
        const ariaLabel = normalized(btn.getAttribute('aria-label'));
        return text.includes('lataa raportti') || ariaLabel.includes('lataa raportti');
      });

      if (!candidate) return false;
      candidate.scrollIntoView({ block: 'center' });
      candidate.click();
      return true;
    });

    if (!clicked) {
      throw new Error('Lataa raportti button not found');
    }
  } catch (error) {
    responsePromise.catch(() => {});
    filePromise.catch(() => {});
    throw error;
  }

  const firstResult = await Promise.race([
    responsePromise
      .then((response) => ({ kind: 'response', response }))
      .catch(() => ({ kind: 'none' })),
    filePromise
      .then((downloadedFilePath) => downloadedFilePath
        ? ({ kind: 'download', downloadedFilePath })
        : ({ kind: 'none' }))
      .catch(() => ({ kind: 'none' })),
  ]);

  if (firstResult.kind === 'response') {
    const response = firstResult.response;
    const buffer = await response.buffer();
    const contentDisposition = response.headers()['content-disposition'] || '';
    const filenameMatch = contentDisposition.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i);
    const originalName = filenameMatch ? decodeURIComponent(filenameMatch[1]) : null;
    return {
      buffer,
      source: 'response',
      filePath: null,
      originalName,
    };
  }

  if (firstResult.kind === 'download') {
    const downloadedFilePath = firstResult.downloadedFilePath;
    const buffer = fs.readFileSync(downloadedFilePath);
    return {
      buffer,
      source: 'download',
      filePath: downloadedFilePath,
      originalName: path.basename(downloadedFilePath),
    };
  }

  throw new Error('Excel report download timed out (no response or downloaded file detected)');
}

async function setReportDate(page, dateString) {
  await page.waitForSelector('input[data-testid="date-input"]', { visible: true, timeout: 20000 });

  await page.click('input[data-testid="date-input"]', { clickCount: 3 });
  await page.keyboard.press('Backspace');
  await page.type('input[data-testid="date-input"]', dateString, { delay: 0 });
  await page.keyboard.press('Enter');

  await page.evaluate(() => {
    const input = document.querySelector('input[data-testid="date-input"]');
    if (!input) return;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.dispatchEvent(new Event('blur', { bubbles: true }));
  });

  await page.waitForNetworkIdle({ idleTime: 700, timeout: 12000 }).catch(() => {});
}

async function korpelaFetch(targetDateOverride = null) {
  if (!process.env.korpela_username || !process.env.korpela_password) return console.error("username or password missing? Configure .env file");
  const timings = {};
  const totalStartedAt = Date.now();
  let inflxData = null;

  //else console.log(`${process.env.korpela_username} ${process.env.korpela_password}`);
  //return;
  const browser = await puppeteer.launch({ headless: true, args: ['--window-size=1920,1080', '--no-sandbox', '--disable-setuid-sandbox'], ignoreDefaultArgs: ['--disable-extensions'] });
  const page = await browser.newPage();
  // Avaa devtools automaattisesti
  //await page.goto('about:blank');


  //page.setViewport({ width: 1920, height: 1080 });
  const loginStartedAt = Date.now();
  await page.goto(korpelaurl);
  await page.waitForNavigation();
  await page.waitForSelector('input[name="username"]');
  await page.waitForSelector('input[name="password"]');
  await page.waitForSelector('button[type="submit"]');
  console.log("login page loaded");
  // Type into login form
  await page.type('input[name="username"]', process.env.korpela_username);
  await page.type('input[name="password"]', process.env.korpela_password);
  await page.click('button[type="submit"]');
  await page.waitForNavigation();
  await page.waitForSelector('input[type="radio"]');
  // click input radio with value KORPELA-204188
  await page.waitForSelector('input[type="radio"][value="KORPELA-204188"]', { visible: true });
  await page.evaluate(() => {
    const radio = document.querySelector('input[type="radio"][value="KORPELA-204188"]');
    if (radio) {
      radio.scrollIntoView();
      radio.click();
    }
  });

  // click button with value <button>Jatka</button>
  await page.waitForSelector('button[type="button"]');

  await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('button[type="button"]')).find(b => b.textContent.includes('Jatka'));
    if (btn) {
      btn.scrollIntoView();
      btn.click();
    }
  });

  //await page.waitForNavigation();
  console.log("logged and selected reporting account");
  timings.loginAndAccountMs = Date.now() - loginStartedAt;

  // search for selector "a href="/reporting/electricity/sales"
  //await page.waitForSelector('a[href="/reporting/electricity/sales"]');
  const salesStartedAt = Date.now();
  await page.evaluate(() => {
    const link = document.querySelector('a[href="/reporting/electricity/sales"]');
    if (link) {
      link.scrollIntoView();
      link.click();
    }
  });
  //await page.waitForNavigation();
  console.log("sales page loaded");
  await page.waitForNetworkIdle({ idleTime: 800, timeout: 25000 });
  timings.openSalesPageMs = Date.now() - salesStartedAt;

  // Aseta vartti data
  // <button type="button" class="chakra-button css-bijwwr" aria-current="true">Vartti</button>
  const quarterStartedAt = Date.now();
  await page.waitForSelector('button[type="button"]');
  await page.evaluate(() => {
    console.log("looking for vartti button");
    const buttons = Array.from(document.querySelectorAll('button[type="button"]'));
    // print all buttons
    console.log("found buttons:", buttons.map(b => b.textContent));
    const varttiBtn = buttons.find(b => b.textContent.includes('Vartti'));
    if (varttiBtn) {
      console.log("clicking vartti button");
      varttiBtn.scrollIntoView();
      varttiBtn.click();
    }
  });
  await page.waitForNetworkIdle({ idleTime: 700, timeout: 12000 }).catch(() => {});
  timings.quarterSelectionMs = Date.now() - quarterStartedAt;

  const setDateStartedAt = Date.now();
  let targetDate;
  if (targetDateOverride) {
    // Accept both dd.MM.yyyy and YYYY-MM-DD formats
    const parsedOverride = DateTime.fromFormat(targetDateOverride, 'dd.MM.yyyy', { zone: 'Europe/Helsinki' }).isValid
      ? DateTime.fromFormat(targetDateOverride, 'dd.MM.yyyy', { zone: 'Europe/Helsinki' })
      : DateTime.fromISO(targetDateOverride, { zone: 'Europe/Helsinki' });
    if (!parsedOverride.isValid) throw new Error(`Invalid --date value: ${targetDateOverride}`);
    targetDate = parsedOverride.toFormat('dd.MM.yyyy');
  } else {
    targetDate = DateTime.now().setZone('Europe/Helsinki').minus({ days: 1 }).toFormat('dd.MM.yyyy');
  }
  await setReportDate(page, targetDate);
  console.log(`report date set to ${targetDate}`);
  timings.setDateMs = Date.now() - setDateStartedAt;

  let runError = null;

  try {
    const downloadStartedAt = Date.now();
    const reportResult = await downloadQuarterHourReport(page);
    timings.downloadReportMs = Date.now() - downloadStartedAt;

    const reportBuffer = reportResult.buffer;

    const dateStamp = DateTime.now().toFormat('yyyyMMdd');
    const xlsxPath = path.join('data', `${dateStamp}_korpela_consumption.xlsx`);
    const jsonPath = path.join('data', `${dateStamp}_korpela_consumption.json`);

    if (reportResult.source === 'download' && reportResult.filePath) {
      if (path.resolve(reportResult.filePath) !== path.resolve(xlsxPath)) {
        fs.copyFileSync(reportResult.filePath, xlsxPath);
      }
    } else {
      fs.writeFileSync(xlsxPath, reportBuffer);
    }
    const xlsxSize = fs.statSync(xlsxPath).size;
    const originalName = reportResult.originalName || path.basename(xlsxPath);
    console.log(`Excel report saved: ${xlsxPath} (${reportResult.source}, original: ${originalName}, size: ${formatBytes(xlsxSize)})`);

    const parseStartedAt = Date.now();
    const measurementData = parseConsumptionReportXlsx(reportBuffer);
    const { dedupedData, removed } = dedupeMeasurementData(measurementData);
    const usageRows = dedupedData?.data?.consumption?.usageHistory?.usages || [];
    fs.writeFileSync(jsonPath, JSON.stringify(dedupedData, null, 2));
    const firstTs = usageRows.length ? usageRows[0].timestamp : 'n/a';
    const lastTs = usageRows.length ? usageRows[usageRows.length - 1].timestamp : 'n/a';
    console.log(`Parsed JSON saved: ${jsonPath} (rows: ${usageRows.length}, removedDuplicates: ${removed}, range: ${firstTs} -> ${lastTs})`);
    timings.parseAndSaveMs = Date.now() - parseStartedAt;

    const writeStartedAt = Date.now();
    await storeInfluxDB(dedupedData);
    timings.writeInfluxMs = Date.now() - writeStartedAt;
    inflxData = dedupedData;

    const removedExcelFiles = cleanupExcelFiles('data');
    console.log(`Removed ${removedExcelFiles.length} Excel file(s) from data directory`);
  } catch (e) {
    console.error('Error downloading or parsing Excel report:', e);
    runError = e;
  } finally {
    timings.totalMs = Date.now() - totalStartedAt;
    logTimingSummary(timings);

    if (verboseLogging && inflxData) {
      const rows = inflxData?.data?.consumption?.usageHistory?.usages?.length || 0;
      console.log(`Verbose summary: wrote ${rows} usage rows.`);
    }

    await browser.close();
  }

  if (runError) {
    throw runError;
  }

}

async function korpelaFetchWithRetry(maxAttempts = maxRetryAttempts, targetDateOverride = null) {
  const attempts = Number.isFinite(maxAttempts) && maxAttempts > 0 ? Math.floor(maxAttempts) : 1;
  let lastError = null;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      if (attempt > 1) {
        console.log(`Retry attempt ${attempt}/${attempts}`);
      }
      await korpelaFetch(targetDateOverride);
      return;
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        const backoffMs = Math.min(5000, attempt * 1500);
        console.log(`Fetch attempt ${attempt} failed, retrying in ${backoffMs} ms...`);
        await wait(backoffMs);
      }
    }
  }

  throw lastError;
}


async function storeInfluxDB(data) {

  const influxUrl = process.env.INFLUXDB_URL;
  const influxToken = process.env.INFLUXDB_TOKEN;
  const influxOrg = process.env.INFLUXDB_ORGANIZATION;
  const influxBucket = process.env.INFLUXDB_BUCKET;
  if (!influxUrl || !influxToken || !influxOrg || !influxBucket) {
    return console.error("InfluxDB configuration missing in .env?");
  }
  const influxDB = new InfluxDB({ url: influxUrl, token: influxToken });
  const writeApi = influxDB.getWriteApi(influxOrg, influxBucket);
  writeApi.useDefaultTags({ place: process.env.INFLUXDB_DEFAULT_TAG_PLACE || 'home' });

  const measurements = data.data.consumption.usageHistory.usages;

  try {
    const ingestStartedAt = Date.now();
    measurements.forEach(meas => {
      if (verboseLogging) {
        console.log(`Writing measurement for ${meas.timestamp} ${meas.value} kW`);
      }
      const point = new Point('energy')
        .timestamp(DateTime.fromISO(meas.timestamp).toJSDate())
        .floatField('usage', parseFloat(meas.value))
      writeApi.writePoint(point);
    })
    if (!verboseLogging) {
      const durationMs = Date.now() - ingestStartedAt;
      console.log(`Prepared ${measurements.length} measurement points (${durationMs} ms)`);
    }
  } catch (error) {
    console.error("Error writing data to InfluxDB:", error);
  }
  await writeApi.close();
  console.log("Data written to InfluxDB");
}


(async () => {
  const args = process.argv.slice(2);

  // Parse --date <value>
  let dateArg = null;
  const dateIdx = args.indexOf('--date');
  if (dateIdx !== -1) {
    dateArg = args[dateIdx + 1];
    if (!dateArg) {
      console.error('--date requires a value, e.g. --date 2026-07-09 or --date 09.07.2026');
      process.exit(1);
    }
    args.splice(dateIdx, 2);
  }

  // Remaining non-flag arg is treated as a filename
  const filename = args.find(a => !a.startsWith('-'));

  if (filename) {
    console.log('arg', filename);
    if (fs.existsSync(filename)) {
      try {
        let data = null;
        if (filename.toLowerCase().endsWith('.xlsx')) {
          const xlsxBuffer = fs.readFileSync(filename);
          data = parseConsumptionReportXlsx(xlsxBuffer);
        } else {
          const json = fs.readFileSync(filename);
          data = JSON.parse(json);
        }
        await storeInfluxDB(data);
      } catch (e) {
        console.error(e);
      }
    }
    process.exit(0);
  } else {
    await korpelaFetchWithRetry(maxRetryAttempts, dateArg);
  }
})();

