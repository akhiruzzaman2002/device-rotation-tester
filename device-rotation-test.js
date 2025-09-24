/**
 * device-rotation-test.js - Automated Multi-Device Browser Testing
 * 
 * Features:
 * - Tests URL across multiple device profiles
 * - Takes screenshots automatically
 * - Handles errors gracefully
 * - Detailed logging
 * 
 * Usage: node device-rotation-test.js <URL>
 * Example: node device-rotation-test.js https://example.com
 */

const { chromium, devices } = require('playwright');
const fs = require('fs').promises;
const path = require('path');

// Configuration
const CONFIG = {
  INTERVAL: 60000, // 60 seconds
  SDK_WAIT: 20000, // 20 seconds
  PAGE_LOAD_TIMEOUT: 60000,
  SCREENSHOT_PREFIX: 'screenshot',
  MAX_ITERATIONS: 1000,
  SCREENSHOT_DIR: 'screenshots'
};

// Device profiles
const DEVICE_PROFILES = [
  { 
    ...devices['iPhone 15 Pro'], 
    name: 'iPhone 15 Pro',
    category: 'mobile'
  },
  { 
    ...devices['Pixel 6'], 
    name: 'Pixel 6',
    category: 'mobile'
  },
  { 
    ...devices['iPad (gen 7)'], 
    name: 'iPad (gen 7)',
    category: 'tablet'
  },
  { 
    name: 'Desktop Chrome',
    viewport: { width: 1366, height: 768 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    deviceScaleFactor: 1,
    isMobile: false,
    hasTouch: false,
    category: 'desktop'
  },
  { 
    ...devices['Galaxy S23'], 
    name: 'Galaxy S23',
    category: 'mobile'
  }
];

// Validate CLI arguments
function validateArguments() {
  const url = process.argv[2];
  
  if (!url) {
    console.error('❌ Error: URL is required');
    console.error('📖 Usage: node device-rotation-test.js <URL>');
    console.error('💡 Example: node device-rotation-test.js https://example.com');
    process.exit(1);
  }

  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    console.error('❌ Error: URL must start with http:// or https://');
    process.exit(1);
  }

  return url;
}

// Graceful shutdown handling
let isShuttingDown = false;
let currentTest = null;

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

function gracefulShutdown(signal) {
  console.log(`\n🛑 Received ${signal}. Shutting down gracefully...`);
  isShuttingDown = true;
  
  if (currentTest) {
    currentTest.cleanup().catch(console.error);
  }
  
  setTimeout(() => process.exit(0), 2000);
}

class DeviceTester {
  constructor(profile, iteration, targetUrl) {
    this.profile = profile;
    this.iteration = iteration;
    this.targetUrl = targetUrl;
    this.profileName = profile.name;
    this.browser = null;
    this.context = null;
    this.page = null;
    this.cleanupCalled = false;
    this.testResults = {
      status: 'unknown',
      error: null,
      screenshotTaken: false,
      httpStatus: 0
    };
  }

  async cleanup() {
    if (this.cleanupCalled) return;
    this.cleanupCalled = true;

    const cleanupTasks = [];
    
    if (this.page && !this.page.isClosed()) {
      cleanupTasks.push(this.page.close().catch(e => 
        console.error(`Error closing page: ${e.message}`))
      );
    }
    
    if (this.context) {
      cleanupTasks.push(this.context.close().catch(e => 
        console.error(`Error closing context: ${e.message}`))
      );
    }
    
    if (this.browser) {
      cleanupTasks.push(this.browser.close().catch(e => 
        console.error(`Error closing browser: ${e.message}`))
      );
    }

    await Promise.allSettled(cleanupTasks);
  }

  async test() {
    try {
      console.log(`\n🚀 Starting test iteration ${this.iteration + 1}`);
      console.log(`📱 Device: ${this.profileName}`);
      console.log(`📏 Viewport: ${this.profile.viewport.width}x${this.profile.viewport.height}`);
      console.log(`🔗 URL: ${this.targetUrl}`);

      // Create screenshot directory
      await this.ensureScreenshotDir();

      // Launch browser
      this.browser = await chromium.launch({ 
        headless: true,
        args: [
          '--disable-dev-shm-usage',
          '--no-sandbox',
          '--disable-setuid-sandbox'
        ],
        timeout: 30000
      });

      // Create context
      this.context = await this.browser.newContext({
        viewport: this.profile.viewport,
        userAgent: this.profile.userAgent,
        deviceScaleFactor: this.profile.deviceScaleFactor || 1,
        isMobile: this.profile.isMobile || false,
        hasTouch: this.profile.hasTouch || false,
        ignoreHTTPSErrors: true
      });

      // Create page
      this.page = await this.context.newPage();
      
      // Setup event handlers
      this.setupEventHandlers();

      // Load page
      await this.loadPage();

      // Wait for SDK initialization
      console.log(`⏳ Waiting ${CONFIG.SDK_WAIT/1000}s for initialization...`);
      await this.page.waitForTimeout(CONFIG.SDK_WAIT);

      // Take screenshot
      await this.takeScreenshot();

      // Collect page info
      await this.collectPageInfo();

      this.testResults.status = 'success';
      return true;

    } catch (error) {
      console.error(`❌ Test failed: ${error.message}`);
      this.testResults.status = 'error';
      this.testResults.error = error.message;
      await this.takeErrorScreenshot();
      return false;
    } finally {
      await this.cleanup();
    }
  }

  async ensureScreenshotDir() {
    try {
      await fs.access(CONFIG.SCREENSHOT_DIR);
    } catch {
      await fs.mkdir(CONFIG.SCREENSHOT_DIR, { recursive: true });
      console.log(`📁 Created directory: ${CONFIG.SCREENSHOT_DIR}`);
    }
  }

  setupEventHandlers() {
    this.page.on('response', response => {
      const status = response.status();
      if (status >= 400) {
        console.warn(`⚠️ HTTP ${status}: ${response.url()}`);
        this.testResults.httpStatus = status;
      }
    });

    this.page.on('console', msg => {
      if (msg.type() === 'error') {
        console.log(`🔴 Console Error: ${msg.text()}`);
      }
    });

    this.page.on('pageerror', error => {
      console.error(`🔴 Page Error: ${error.message}`);
    });
  }

  async loadPage() {
    try {
      const response = await this.page.goto(this.targetUrl, { 
        waitUntil: 'domcontentloaded',
        timeout: CONFIG.PAGE_LOAD_TIMEOUT 
      });

      if (response) {
        this.testResults.httpStatus = response.status();
        console.log(`📊 HTTP Status: ${response.status()}`);
        
        if (response.status() >= 400) {
          throw new Error(`HTTP ${response.status()} - ${response.statusText()}`);
        }
      }

    } catch (error) {
      if (error.name === 'TimeoutError') {
        console.log('⏰ Page load timeout, continuing...');
      } else {
        throw error;
      }
    }
  }

  async takeScreenshot() {
    try {
      const safeName = this.profileName.toLowerCase().replace(/[^a-z0-9]/g, '-');
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const screenshotPath = path.join(
        CONFIG.SCREENSHOT_DIR, 
        `${CONFIG.SCREENSHOT_PREFIX}-${timestamp}-${safeName}.png`
      );
      
      await this.page.screenshot({ 
        path: screenshotPath, 
        fullPage: true,
        type: 'png',
        quality: 80
      });

      this.testResults.screenshotTaken = true;
      this.testResults.screenshotPath = screenshotPath;
      console.log(`📸 Screenshot saved: ${screenshotPath}`);

    } catch (error) {
      console.error('Error taking screenshot:', error.message);
    }
  }

  async takeErrorScreenshot() {
    if (!this.page) return;
    
    try {
      const safeName = this.profileName.toLowerCase().replace(/[^a-z0-9]/g, '-');
      const screenshotPath = path.join(
        CONFIG.SCREENSHOT_DIR,
        `error-${CONFIG.SCREENSHOT_PREFIX}-${safeName}.png`
      );
      
      await this.page.screenshot({ path: screenshotPath });
      console.log(`📸 Error screenshot: ${screenshotPath}`);
    } catch (error) {
      console.error('Failed to take error screenshot:', error.message);
    }
  }

  async collectPageInfo() {
    try {
      const pageTitle = await this.page.title();
      const currentUrl = this.page.url();
      
      console.log(`📄 Page Title: "${pageTitle}"`);
      console.log(`🔗 Current URL: ${currentUrl}`);
      console.log(`✅ Page loaded successfully`);

    } catch (error) {
      console.error('Error collecting page info:', error.message);
    }
  }
}

function sleep(ms) {
  return new Promise(resolve => {
    const timeout = setTimeout(resolve, ms);
    
    const checkInterval = setInterval(() => {
      if (isShuttingDown) {
        clearTimeout(timeout);
        clearInterval(checkInterval);
        resolve();
      }
    }, 1000);
  });
}

async function runTests() {
  const targetUrl = validateArguments();
  
  console.log('🎯 Starting Device Rotation Test');
  console.log('📊 Target URL:', targetUrl);
  console.log('⏰ Interval:', CONFIG.INTERVAL/1000, 'seconds');
  console.log('📱 Device Profiles:', DEVICE_PROFILES.length);
  console.log('📁 Screenshot Directory:', CONFIG.SCREENSHOT_DIR);
  console.log('💡 Press CTRL+C to stop the test');
  console.log('='.repeat(50));

  let iteration = 0;
  let successCount = 0;
  let errorCount = 0;

  // Create screenshot directory
  try {
    await fs.mkdir(CONFIG.SCREENSHOT_DIR, { recursive: true });
  } catch (error) {
    console.error('Error creating directory:', error.message);
  }

  while (!isShuttingDown && iteration < CONFIG.MAX_ITERATIONS) {
    const profileIndex = iteration % DEVICE_PROFILES.length;
    const profile = DEVICE_PROFILES[profileIndex];
    
    console.log(`\n${'='.repeat(50)}`);
    console.log(`🔄 Iteration ${iteration + 1} - ${new Date().toLocaleString()}`);
    console.log(`📱 Testing on: ${profile.name} (${profile.category})`);
    console.log(`${'='.repeat(50)}`);

    const tester = new DeviceTester(profile, iteration, targetUrl);
    currentTest = tester;
    const success = await tester.test();
    currentTest = null;
    
    if (success) {
      successCount++;
    } else {
      errorCount++;
    }

    const totalTests = iteration + 1;
    const successRate = ((successCount / totalTests) * 100).toFixed(1);
    
    console.log(`\n📊 Progress Summary:`);
    console.log(`   ✅ Successful: ${successCount}`);
    console.log(`   ❌ Failed: ${errorCount}`);
    console.log(`   📈 Success Rate: ${successRate}%`);
    console.log(`   🔄 Total Tests: ${totalTests}`);

    iteration++;

    // Wait for next iteration
    if (!isShuttingDown && iteration < CONFIG.MAX_ITERATIONS) {
      console.log(`\n💤 Waiting ${CONFIG.INTERVAL/1000} seconds...`);
      await sleep(CONFIG.INTERVAL);
    }
  }

  console.log('\n✅ Test session completed');
  console.log(`🎯 Final Results: ${successCount} passed, ${errorCount} failed`);
}

// Error handling
process.on('unhandledRejection', (error) => {
  console.error('Unhandled Rejection:', error);
  process.exit(1);
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  process.exit(1);
});

// Main execution
(async () => {
  try {
    await runTests();
  } catch (error) {
    console.error('Fatal error:', error);
    process.exit(1);
  }
})();
