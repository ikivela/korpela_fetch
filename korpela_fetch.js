const puppeteer = require('puppeteer');
const { DateTime } = require('luxon');
const { InfluxDB, Point } = require('@influxdata/influxdb-client');

require('dotenv').config();

var korpelaurl = "https://omakorpela.korpelanvoima.fi/login";

async function korpelaFetch() {

  var measurementData = "";

  if (!process.env.korpela_username || !process.env.korpela_password) return console.error("username or password missing? Configure .env file");
  //else console.log(`${process.env.korpela_username} ${process.env.korpela_password}`);
  //return;
  const browser = await puppeteer.launch({ headless: true, args: ['--window-size=1920,1080'], ignoreDefaultArgs: ['--disable-extensions'] });
  const page = await browser.newPage();
  // Avaa devtools automaattisesti
  //await page.goto('about:blank');


  //page.setViewport({ width: 1920, height: 1080 });
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

  // search for selector "a href="/reporting/electricity/sales"
  //await page.waitForSelector('a[href="/reporting/electricity/sales"]');
  await page.evaluate(() => {
    const link = document.querySelector('a[href="/reporting/electricity/sales"]');
    if (link) {
      link.scrollIntoView();
      link.click();
    }
  });
  //await page.waitForNavigation();
  console.log("sales page loaded");
  await page.waitForNetworkIdle({ idleTime: 2000, timeout: 60000 });

  // Aseta vartti data
  // <button type="button" class="chakra-button css-bijwwr" aria-current="true">Vartti</button>
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
  // aseta datepickeriin eilinen p�iv�m��r�
  // <input aria-label="P�iv�m��r�n sy�tt�" autocomplete="off" data-testid="date-input" id="datepicker-custom-input" class="chakra-input css-oapnk9" value="27.12.2025">
  //const yesterday = DateTime.now().minus({ days: 1 }).setLocale('fi').toFormat('dd.MM.yyyy');
  //await page.waitForSelector('input[data-testid="date-input"]');
  //await page.evaluate((date) => {
  //   const dateinput = document.querySelector('input[data-testid="date-input"]');
  //   if (dateinput) {
  //     dateinput.value = date;
  //     const event = new Event('input', { bubbles: true });
  //     dateinput.dispatchEvent(event);
  //   }
  // }, yesterday);



  //console.log("date set to ", yesterday);

  page.on('response', async (response) => {
    const url = response.url();
    // Tarkista onko graphql pyynt�, jossa kysyt��n mittausdataa (consumption)
    if (url.includes('/graphql') && response.request().postData()?.includes('GetConsumptionData')) {
      console.log("GraphQL response detected:", url);
      try {
        measurementData = await response.json();
        // Voit tarkistaa queryn nimen datasta, esim. data.data.GetConsumptionData
        // Anna tiedostonimi joko tulee aikaleima
        console.log('GraphQL-vastaus tallennettu!');
      } catch (e) {
        // Ei JSON-vastaus
        console.error("Error parsing GraphQL response:", e);
      }
    }
  });

  page.waitForNetworkIdle({ idleTime: 2000, timeout: 60000 }).then(async () => {
    console.log("Network idle detected, assuming all data loaded.");
    await browser.close();

    // tallennetaan kulutusdata influxdb cloudiin
    await storeInfluxDB(measurementData);
  });

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
    measurements.forEach(meas => {
      console.log(`Writing measurement for ${meas.timestamp} ${meas.value} kW`);
      const point = new Point('energy')
        .timestamp(DateTime.fromISO(meas.timestamp).toJSDate())
        .floatField('usage', parseFloat(meas.value))
      writeApi.writePoint(point);
    })
  } catch (error) {
    console.error("Error writing data to InfluxDB:", error);
  }
  await writeApi.close();
  console.log("Data written to InfluxDB");
}


(async () => {
  await korpelaFetch();
  //test = { data: { consumption: { range: { items: [{ startTime: "2024-06-25T00:00:00Z", sum: "1.23", costWithVat: "0.15", costWithoutVat: "0.12" }, { startTime: "2024-06-25T00:15:00Z", sum: "1.45", costWithVat: "0.18", costWithoutVat: "0.15" }] } } } };
  //await storeInfluxDB();
})();

