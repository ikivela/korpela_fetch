const puppeteer = require('puppeteer');
const { DateTime } = require('luxon');
const { writeMeasurements } = require('../common/influx-db.js');
const cheerio = require('cheerio');
const vm = require('vm');


var korpelaurl = 'https://asiakkaat.korpelanvoima.fi/eServices/Online/IndexNoAuth';



async function sendInflux(datas) {

  var meas = [];
  for (let data of datas) {
    meas.push({
      measurement: 'rpiphatMeasurements',
      timestamp: DateTime.fromMillis(data[0]).toJSDate(),
      tags: [{ name: 'name', value: 'koivuniemi' }],
      fields: [{ type: 'float', name: 'energy', value: data[1] }]

    })
  }

  if (!process.env.DEBUG)
    await writeMeasurements(meas);

}


async function parseData(_html) {

  const context = vm.createContext();

  //const html = fs.readFileSync('../../tmp/vastaus.html');
  var $ = cheerio.load(_html);
  console.log("cheerio run");
  // language="javascript" type="text/javascript
  var scriptTags = $("script[language='javascript']");

  if (scriptTags) {
    var scriptdata = $(scriptTags).html();

    const modelMatch = scriptdata.match(/var\s+model\s*=\s*\{[\s\S]*?\};/);
    if (modelMatch) {
      console.log("match!");

      vm.runInContext(modelMatch[0], context);
      if (context.model) {
        var Stop = context.model.Hours.Consumptions[0].Series.Stop;
        console.log(`[${Stop}]`);

        var end = DateTime.fromJSDate(Stop);
        var start = end.minus({ 'day': 1 });
        console.log(start.toISO(), end.toISO());
        var daydata = context.model.Hours.Consumptions[0].Series.Data.filter(x => x[0] > start.toMillis() && x[0] <= end.toMillis());
        if (daydata)
          await sendInflux(daydata);
      }

    }

  };
}

module.exports = async function (context, req) {

  if (!process.env.korpela_username || !process.env.korpela_password) return console.error("username or password missing? Configure .env file");

  try {
    const browser = await puppeteer.launch({ headless: "new", args: ['--window-size=1920,1080', '--no-sandbox'], ignoreDefaultArgs: ['--disable-extensions'] });
    const page = await browser.newPage();
    const client = await page.target().createCDPSession()
    await client.send('Page.setDownloadBehavior', {
      behavior: 'allow',
      downloadPath: '',
    })

    page.setViewport({ width: 1920, height: 1080 });
    await page.goto(korpelaurl);

    // Type into search box.
    await page.type('#emailfield', process.env.korpela_username);
    await page.type('#Password', process.env.korpela_password);
    await page.click('#loginsubmit');
    // /html/body/div[2]/header/div[2]/div/div[2]/ul[2]/li/a
    await page.waitForNetworkIdle();
    //await page.waitForSelector('li[class="dropdown"]');
    await page.click('li[class="dropdown"]');
    await page.waitForSelector('a[href="/eServices/Online/ChangeSelectedUser/5111?userName=veera.kivela%40gmail.com"');
    await page.click('a[href="/eServices/Online/ChangeSelectedUser/5111?userName=veera.kivela%40gmail.com"')

    await page.waitForSelector('a[href="/Reporting/CustomerConsumption?loadLastYearData=True"');
    await page.click('a[href="/Reporting/CustomerConsumption?loadLastYearData=True"');

    await page.waitForNetworkIdle();
    const html = await page.content();
    if (html) {

      await parseData(html);
    } else {
      context.log("Page content failed to load");
    }


  } catch (_err) {
    return context.res = {
      status: 500,
      body: JSON.stringify(_err)
    };
  } finally {
    return context.res = {
      status: 200,
      body: 'ok'
    }
  }

}