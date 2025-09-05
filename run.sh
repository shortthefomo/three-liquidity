#!/bin/bash
export NODE_ENV=production
export DEBUG=pools*
pm2 start ./src/liquidity.js --name three-liquidity --time