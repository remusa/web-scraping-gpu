import Database from 'better-sqlite3'
import dotenv from 'dotenv'
import fs from 'fs/promises'
import playwright from 'playwright'
import twilio from 'twilio'

dotenv.config()

const URL = process.env.URL || ''
const accountSid = process.env.TWILIO_ACCOUNT_SID
const authToken = process.env.TWILIO_AUTH_TOKEN
const twilioPhoneNumber = process.env.TWILIO_PHONE_NUMBER
const myPhoneNumber = process.env.MY_PHONE_NUMBER
const notifyThreshold = Number.parseFloat(process.env.NOTIFY_THRESHOLD)
const STOCK_ALERT = Number.parseInt(process.env.STOCK_ALERT)

const client = twilio(accountSid, authToken)
const fileReadme = 'README.md'

const db = new Database('data.db', { verbose: console.log })

const dateFormatter = new Intl.DateTimeFormat('es-MX', {
  dateStyle: 'short',
  timeStyle: 'short',
  hourCycle: 'h12',
  calendar: 'gregory',
})
const currencyFormatter = new Intl.NumberFormat('es-MX', {
  style: 'currency',
  currency: 'MXN',
})

function initializeDb() {
  try {
    const createTable = `CREATE TABLE IF NOT EXISTS items(
      'url' TEXT,
      'price' REAL,
      'stock' INTEGER,
      'created_at' DATETIME NOT NULL DEFAULT current_timestamp,
      'updated_at' DATETIME NOT NULL DEFAULT current_timestamp
    );`
    db.exec(createTable)
  } catch (err) {
    console.error(err)
  }
}

async function scrape() {
  const browser = await playwright['chromium'].launch({
    // headless: false,
    // slowMo: 100, // Uncomment to visualize test
  })
  const page = await browser.newPage()
  await page.goto(URL)
  await page.screenshot({ path: 'screenshot.png' })

  const now = dateFormatter.format(new Date())
  const priceElement = (await page.locator('.oldPrice cp-ar').textContent()) || '0'
  const price = Number.parseFloat(priceElement?.trim()?.replace(/[$,]/gi, ''))
  const stockElement = await page.locator('.stockFlag').textContent()
  const stock = Number.parseInt(stockElement?.trim()?.replace('Disponibles: ', '')?.replace('pzas.', '') ?? '0')
  const newItem = { now, price, stock }

  await page.waitForTimeout(1_000)
  await browser.close()

  return newItem
}

function parsePrice(price) {
  return Number.parseFloat(price.substring(1))
}

async function writeReadme({ min, newItem, lastItem }) {
  const { min: historicalMin } = min
  const historicalLowest = currencyFormatter.format(historicalMin.toString())
  const historicalLowestDate = min.created_at
  const { now: lastChecked, price, stock } = newItem
  const lastPrice = currencyFormatter.format(lastItem.price)
  const currentPrice = currencyFormatter.format(price)
  const priceDiff = parsePrice(lastPrice) - parsePrice(currentPrice)
  const overMin = currencyFormatter.format(price - historicalMin)
  const readme = `# web-scrapers

  [![Scrape latest data](https://github.com/remusa/web-scraping/actions/workflows/scrape.yml/badge.svg)](https://github.com/remusa/web-scraping/actions/workflows/scrape.yml)

  ![screenshot](screenshot.png)

  | Lowest price | Lowest price (date) | Last checked | Previous price | Current price | Change | Over min. | Stock available |
  |---|---|---|---|
  | ${historicalLowest} | ${historicalLowestDate} | ${lastChecked} | ${lastPrice} | ${currentPrice} | ${priceDiff} | ${overMin} | ${stock} |
  `
  await fs.writeFile(fileReadme, readme)
}

function voiceCall() {
  client.calls
    .create({
      url: 'http://demo.twilio.com/docs/voice.xml',
      to: myPhoneNumber,
      from: twilioPhoneNumber,
    })
    .then((call) => console.log(`Call SID: ${call.sid}`))
    .done()
}

async function run() {
  try {
    const newItem = await scrape()
    initializeDb()
    const prevMin = db.prepare('SELECT MIN(price) as min, created_at FROM items;').get().min
    const lastItem = db.prepare('SELECT MAX(created_at), price from items;').get()
    const insert = db.prepare('INSERT INTO items (url, price, stock) VALUES (@url, @price, @stock);')
    insert.run({ url: URL, price: newItem.price, stock: newItem.stock })
    const min = db.prepare('SELECT MIN(price) as min, created_at FROM items;').get()
    await writeReadme({ min, newItem, lastItem })
    const newMin = newItem.price < prevMin
    const priceDecrement = newItem.price < lastItem.price
    const fewLeft = newItem.stock <= STOCK_ALERT
    const lowerThreshold = newItem.price < notifyThreshold

    if (newMin || priceDecrement || fewLeft || lowerThreshold) {
      voiceCall()
    }
  } catch (err) {
    console.error(err)
  } finally {
    db.close()
  }
}

run()
