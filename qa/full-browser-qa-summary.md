# CHAIN//LAB full browser QA

- Finished: 2026-08-07T15:28:52.134Z
- Passed: 31
- Failed: 19
- Skipped: 1
- Production authenticated credentials configured: no

## Failures
- **local-desktop / seed-recovery renders without browser errors:** Error: seed-recovery: runtime problems: http 404: http://127.0.0.1:4173/vendor/ethers.umd.min.js | console: Failed to load resource: the server responded with a status of 404 (File not found) | console: Refused to apply inline style because it violates the following Content Security Policy directive: "style-src 'self'". Either the 'unsafe-inline' keyword, a hash ('sha256-VBgwVVLj3YEviJ41YqSKU4P/7zAEl7gisUh5tPkuwa0='), or a nonce ('nonce-...') is required to enable inline execution.
- **local-desktop / advanced-recovery renders without browser errors:** Error: advanced-recovery: runtime problems: http 404: http://127.0.0.1:4173/vendor/ethers.umd.min.js | console: Failed to load resource: the server responded with a status of 404 (File not found) | console: Refused to connect to 'http://127.0.0.1:4173/api/me' because it violates the following Content Security Policy directive: "connect-src 'none'".
- **local-mobile / dashboard renders without browser errors:** Error: dashboard: mobile drawer is outside viewport
- **local-mobile / evm-auditor renders without browser errors:** Error: evm-auditor: mobile drawer is outside viewport
- **local-mobile / btc-discovery renders without browser errors:** Error: btc-discovery: mobile drawer is outside viewport
- **local-mobile / address-workspace renders without browser errors:** Error: address-workspace: controls outside viewport: [{"tag":"BUTTON","id":"","text":"","rect":{"x":382.515625,"y":9,"width":46,"height":46,"top":9,"right":428.515625,"bottom":55,"left":382.515625}}]
- **local-mobile / jobs renders without browser errors:** Error: jobs: controls outside viewport: [{"tag":"BUTTON","id":"","text":"","rect":{"x":382.515625,"y":9,"width":46,"height":46,"top":9,"right":428.515625,"bottom":55,"left":382.515625}}]
- **local-mobile / notifications renders without browser errors:** Error: notifications: controls outside viewport: [{"tag":"BUTTON","id":"","text":"","rect":{"x":382.515625,"y":9,"width":46,"height":46,"top":9,"right":428.515625,"bottom":55,"left":382.515625}}]
- **local-mobile / approvals renders without browser errors:** Error: approvals: controls outside viewport: [{"tag":"BUTTON","id":"","text":"","rect":{"x":382.515625,"y":9,"width":46,"height":46,"top":9,"right":428.515625,"bottom":55,"left":382.515625}}]
- **local-mobile / exports renders without browser errors:** Error: exports: controls outside viewport: [{"tag":"BUTTON","id":"","text":"","rect":{"x":382.515625,"y":9,"width":46,"height":46,"top":9,"right":428.515625,"bottom":55,"left":382.515625}}]
- **local-mobile / btc-research renders without browser errors:** Error: btc-research: mobile drawer is outside viewport
- **local-mobile / seed-recovery renders without browser errors:** Error: seed-recovery: mobile drawer is outside viewport
- **local-mobile / advanced-recovery renders without browser errors:** Error: advanced-recovery: mobile drawer is outside viewport
- **local-mobile / admin renders without browser errors:** Error: admin: mobile drawer is outside viewport
- **local-mobile / login renders without browser errors:** Error: login: mobile drawer is outside viewport
- **local-interaction / advanced recovery self-tests and exact known-address recovery:** page.waitForFunction: Timeout 20000ms exceeded.
- **local-interaction / guided seed recovery exact ETH match and sensitive-data clearing:** page.waitForSelector: Timeout 30000ms exceeded.
- **production-public / production login and intro render on desktop:** Error: Production desktop login problems: console: Refused to execute script from 'https://portofele.vercel.app/login.html?next=%2Fuser-shell.js' because its MIME type ('text/html') is not executable, and strict MIME type checking is enabled. | console: Refused to apply style from 'https://portofele.vercel.app/login.html?next=%2Fresponsive-2026-fixes.css' because its MIME type ('text/html') is not a supported stylesheet MIME type, and strict MIME checking is enabled.
- **production-public / production login and intro render on mobile:** Error: production-login: mobile drawer is outside viewport

## Skipped
- **production-authenticated / authenticated production desktop and mobile route pass:** QA_USERNAME and QA_PASSWORD repository secrets are not configured
