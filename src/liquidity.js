'use strict'
const xrpl = require('xrpl')
const dotenv = require('dotenv')
const debug = require('debug')
const log = debug('pools:discovery')

const io = require('@pm2/io')
const app = require('express')()
const http = require('http')
const crypto = require('crypto')

io.init({
  transactions: true, // will enable the transaction tracing
  http: true // will enable metrics about the http server (optional)
})

dotenv.config()

log('using http: for webhead: ' + (process.env.APP_PORT))


http.createServer(app).listen(process.env.APP_PORT)

class main {
	constructor(Config) {
    // Store unique pairs and their details
    const uniquePairs = new Set()
    const pairDetails = {}
    let timeout = undefined

		Object.assign(this, {
      start() {
        this.run()
        this.service()
      },
      async run() {
        if (timeout !== undefined) {
          clearTimeout(timeout)
        }
        const rippledServer = process.env.RIPPLED
        const self = this
        await self.discoverAllPairs(rippledServer)
        timeout = setTimeout(() => {
          self.run()
          log('Pairs', Object.entries(pairDetails).length)
        }, 60000)
      },
      service() {
				// const self = this
				app.get('/api/v1/liquidity', async function(req, res) {
					res.setHeader('Access-Control-Allow-Origin', '*')
            log('Called: ' + req.route.path, req.query)
            res.json(pairDetails)
        })
      },
      hashObject(obj) {
        // Convert the object to a consistent JSON string.
        // Using a replacer function with sorting ensures consistent key order,
        // which is crucial for generating the same hash for identical objects
        // regardless of property order.
        const jsonString = JSON.stringify(obj, (key, value) => {
          if (value && typeof value === 'object' && !Array.isArray(value)) {
            // Sort object keys for consistent stringification
            return Object.keys(value).sort().reduce((sortedObj, k) => {
              sortedObj[k] = value[k]
              return sortedObj
            }, {})
          }
          return value
        })

        // Create a SHA-256 hash
        const hash = crypto.createHash('sha256')

        // Update the hash with the JSON string data
        hash.update(jsonString)

        // Get the digest in hexadecimal format
        return hash.digest('hex')
      },
      // Helper to normalize asset to object form (handles XRP as string or object)
      normalizeAsset(asset) {
        if (typeof asset === 'string') {
          return { currency: 'XRP' }
        }
        return asset
      },
      currencyHexToUTF8(code) {
        if (code === undefined) return 'XRP'
        if (code.length === 3)
          return code

        let decoded = new TextDecoder()
          .decode(this.hexToBytes(code))
        let padNull = decoded.length

        while (decoded.charAt(padNull - 1) === '\0')
          padNull--

        return decoded.slice(0, padNull)
      },
      hexToBytes(hex) {
        let bytes = new Uint8Array(hex.length / 2)

        for (let i = 0; i !== bytes.length; i++) {
          bytes[i] = parseInt(hex.substr(i * 2, 2), 16)
        }

        return bytes
      },
      // Helper to get a string key for a unique pair (sorted to avoid duplicates)
      getPairKey(assetA, assetB) {
        assetA = this.normalizeAsset(assetA)
        assetB = this.normalizeAsset(assetB)
        const pair = [assetA, assetB].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
        pair[0].currency_human = this.currencyHexToUTF8(pair[0].currency)
        pair[1].currency_human = this.currencyHexToUTF8(pair[1].currency)
        return { asset1: pair[0], asset2: pair[1], key: this.hashObject(pair) }
      },

      // Helper to fetch AMM liquidity details
      async fetchAMMLiquidity(client, asset1, asset2) {
        try {
          const response = await client.request({
            command: 'amm_info',
            asset: asset1,
            asset2: asset2
          })
          if ('error' in response.result) { 
            log('warn', `Failed to fetch AMM liquidity for ${asset1.currency}/${asset2.currency}:`, error.message)
            return null
          }

          const amm = response.result.amm
          return {
            amount1: amm.amount,
            amount2: amm.amount2,
            ratio: (typeof amm.amount2 == 'object' ? amm.amount2.value : (amm.amount2) / 1_000_000) / (typeof amm.amount == 'object' ? amm.amount.value : (amm.amount) / 1_000_000),
            lp_token: amm.lp_token?.value || '0',
            trading_fee: amm.trading_fee
          }
        } catch (error) {
          log('warn', `Failed to fetch AMM liquidity for ${asset1.currency}/${asset2.currency}:`, error.message)
          return null
        }
      },
      async fetchCLOBBook(client, assetA, assetB) {
        let marker
        let entryCount = 0

        // Process order books
        do {
          const request = {
            command: 'book_offers',
            ledger_index: 'validated',
            taker: process.env.PING_ACCOUNT_ADDRESS,
            taker_gets: assetA,
            taker_pays: assetB,
            limit: 1000,
            marker: marker,
            binary: false
          }

          const response = await client.request(request)
          if ('error' in response.result) { break }

          // log('book', response.result.offers)
          let liquidityA = 0
          let liquidityB = 0
          log(response.result.offers)
          response.result.offers.forEach(offer => {
            if (offer.taker_pays_funded !== undefined) {
              entryCount++
              liquidityA += typeof offer.TakerGets === 'object' ? parseFloat(offer.TakerGets.value) : parseFloat(offer.TakerGets)
              liquidityB += typeof offer.TakerPays === 'object' ? parseFloat(offer.TakerPays.value) : parseFloat(offer.TakerPays)  
            }
          })
          if (response.result.offers.length > 0) {
            const { asset1, asset2, key } = this.getPairKey(assetA, assetB)
            pairDetails[key]['DEX'] = {
              liquidity: {
                amount1: assetB.currency === 'XRP' ? liquidityB : {currency: assetB.currency, issuer: assetB.issuer, value: liquidityB},
                amount2: assetA.currency === 'XRP' ? liquidityA : {currency: assetA.currency, issuer: assetA.issuer, value: liquidityA},
                offers: response.result.offers.length
              },
            }
          }
          marker = response.result.marker
          log(`Processed ${entryCount} offer entries...`)
        } while (marker)
      },

      async fetchAMMPools(client) {
        let marker
        let entryCount = 0
        
        // Process AMM pools
        log('Scanning AMM pools...')
        do {
          const request = {
            command: 'ledger_data',
            ledger_index: 'validated',
            type: 'amm',
            limit: 1000,
            marker: marker,
            binary: false
          }

          const response = await client.request(request)
          if ('error' in response.result) { break }
          const entries = response.result.state || []

          for (const entry of entries) {
            entryCount++
            const assetA = this.normalizeAsset(entry.Asset)
            const assetB = this.normalizeAsset(entry.Asset2)

            const { asset1, asset2, key } = this.getPairKey(assetA, assetB)
            if (!uniquePairs.has(key)) {
              uniquePairs.add(key)
              const liquidity = await this.fetchAMMLiquidity(client, asset1, asset2)
              pairDetails[key] = {
                asset1,
                asset2
              }

              pairDetails[key]['AMM'] = {
                liquidity,
                pool: entry.Account
              }
              await this.fetchCLOBBook(client, assetA, assetB, pairDetails)
            }
          }

          marker = response.result.marker

          log(`Processed ${entryCount} AMM entries...`)
        } while (marker)
      },


      async discoverAllPairs(rippledServer = process.env.RIPPLED) {
        log(`Discovering all pairs from XRPL`)
        try {
          // Connect to your XRPL node
          const client = new xrpl.Client(rippledServer)
          log('Connecting to XRPL node...')
          await client.connect()
          log('Connected to XRPL node.')

          
          
          
          log('Scanning order books...')
          await this.fetchAMMPools(client)

          // Output results
          // log(`\nDiscovered Pairs for ${token}${issuer ? ` (Issuer: ${issuer})` : ''}:`)
          // log(pairDetails)
          for (const [key, value] of Object.entries(pairDetails)) {
            // only really interested in DEX + AMM pools for now
            if (value.DEX == undefined) { continue }

            if (value.asset1.currency === 'XRP') {
              log(`XRP/${this.currencyHexToUTF8(value.asset2.currency)}:${value.asset2.issuer}`)
            }
            else if(value.asset2.currency === 'XRP') {
              log(`${this.currencyHexToUTF8(value.asset1.currency)}:${value.asset1.issuer}/XRP`)
            }
            else {
              log(`${this.currencyHexToUTF8(value.asset1.currency)}:${value.asset1.issuer}/${this.currencyHexToUTF8(value.asset2.currency)}:${value.asset2.issuer}`)
            }
            
            if (value.AMM !== undefined) {
              log(`  Pool: ${value.AMM.pool}`)
              log(`  AMM Liquidity: ${typeof value.AMM.liquidity.amount1 == 'object' ? value.AMM.liquidity.amount1.value : (value.AMM.liquidity.amount1) / 1_000_000} ${this.currencyHexToUTF8(value.AMM.liquidity.amount1.currency)}, ${typeof value.AMM.liquidity.amount2 == 'object' ? value.AMM.liquidity.amount2.value : (value.AMM.liquidity.amount2) / 1_000_000} ${this.currencyHexToUTF8(value.AMM.liquidity.amount2.currency)}`)
              log(`  Ratio AMM ${value.AMM.liquidity.ratio}`)
              log(`  LP Token Supply: ${value.AMM.liquidity.lp_token}`)
              log(`  Trading Fee: ${value.AMM.liquidity.trading_fee}`)
            }
            if (value.DEX !== undefined) {
              log(`  DEX Liquidity: ${typeof value.DEX.liquidity.amount1 == 'object' ? value.DEX.liquidity.amount1.value : (value.DEX.liquidity.amount1) / 1_000_000} ${this.currencyHexToUTF8(value.DEX.liquidity.amount1.currency)}, ${typeof value.DEX.liquidity.amount2 == 'object' ? value.DEX.liquidity.amount2.value : (value.DEX.liquidity.amount2) / 1_000_000} ${this.currencyHexToUTF8(value.DEX.liquidity.amount2.currency)}`)
              log(`  Offers: ${value.DEX.liquidity.offers == undefined ? 0 : value.DEX.liquidity.offers}`)
            }
          }

          // Disconnect
          await client.disconnect()
          log('Disconnected from XRPL node.')

          // Return structured data
          return pairDetails
        } catch (error) {
          log('error', 'Error discovering pairs:', error)
          // throw error
        }
      },
      async pause(milliseconds = 1000) {
				return new Promise(resolve => {
				//   console.log('pausing....')
				  setTimeout(resolve, milliseconds)
				})
			},
    })
  }
}

const runner = new main()
runner.start()
