const { chromium } = require('playwright');
const path = require('path');

(async () => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    
    page.on('console', msg => console.log('PAGE LOG:', msg.text()));
    page.on('pageerror', err => console.log('PAGE ERROR:', err.message));

    await page.goto('http://localhost:3000/');
    
    // Set file to input
    const fileInput = await page.$('input[type="file"]');
    await fileInput.setInputFiles('big_test.pdf');
    
    // Fill client name
    await page.fill('input[placeholder="Enter client name"]', 'Client');
    // Fill report name
    await page.fill('input[placeholder="Enter report name"]', 'Report');

    // intercept dialogs
    page.on('dialog', async dialog => {
      console.log('DIALOG MESSAGE:', dialog.message());
      await dialog.accept();
    });

    // Click generate Link
    await page.click('button:has-text("Generate Link")');
    
    // Wait for a bit
    await page.waitForTimeout(5000);
    
    await browser.close();
})();
