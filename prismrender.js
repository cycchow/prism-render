const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const puppeteer = require('puppeteer');
const urlModule = require('url');
const { spawn } = require('child_process'); // Import spawn to handle zombie processes

const app = express();
const port = 3000;
const angularAppPort = 4200;

let browser; // Reuse a single browser instance
let browserRestartInterval = 60; // Restart browser every 60 requests
let prerenderCount = 0;
let isRestarting = false; // Add a flag to indicate if the browser is restarting
let cleanupRunning = false; // Flag to prevent concurrent cleanup

async function launchBrowser() {
    if (!browser && !isRestarting) {
        isRestarting = true; // Set the flag to true before launching
        try {
            console.log('Launching browser...');
            browser = await puppeteer.launch({
                headless: 'new',
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-gpu',
                    '--disable-dev-shm-usage', // Prevent Chrome from running out of memory
                    '--single-process', // Run Chrome in single-process mode
                ],
                protocolTimeout: 240000, // Increase protocol timeout to 4 minutes
            });
            console.log('Browser launched successfully.');
        } catch (error) {
            console.error('Error launching browser:', error);
            if (error.message.includes('Network.enable timed out')) {
                console.log('ProtocolError: Network.enable timed out. Restarting browser...');
                if (browser) { // Check if browser exists before closing
                    await closeBrowser(); // Close the browser if it exists
                }
                browser = null; // Set browser to null
            }
        } finally {
            isRestarting = false; // Reset the flag after launching (or failing to launch)
        }
    }
    return browser;
}

async function prerender(targetUrl, userAgent = 'Mozilla/5.0', clientIp = '', retryCount = 0) {
    try {
        // Restart the browser if the count exceeds the interval
        if (browserRestartInterval !== -1 && prerenderCount >= browserRestartInterval) {
            console.log('Restarting browser to free up resources...');
            if (browser) {
                await closeBrowser(); // Explicitly close the browser and its processes
            }
            browser = null;
            prerenderCount = 0;
        }

        // Wait for the browser to launch
        if (isRestarting) {
            console.log('Browser is restarting, waiting for it to start...');
            while (isRestarting) {
                await new Promise(resolve => setTimeout(resolve, 100)); // Wait 100ms
            }
            console.log('Browser started, continuing prerender');
        }

        browser = await launchBrowser();

        // Check if browser is still connected before using it
        if (!browser || !browser.isConnected()) {
            console.log('Browser is not connected or launch failed, attempting to relaunch...');
            if (browser) {
                await closeBrowser();
            }
            browser = await launchBrowser();
            if (!browser || !browser.isConnected()) {
                console.log('Browser relaunch failed, skipping prerender');
                return null;
            }
        }

        const page = await browser.newPage();

        try {
            // Set user agent for accurate GA4 tracking (coerce to string to avoid protocol errors)
            const safeUserAgent = (typeof userAgent === 'string' && userAgent.trim() !== '') ? userAgent : 'Mozilla/5.0';
            try {
                await page.setUserAgent(String(safeUserAgent));
            } catch (uaError) {
                console.error('Failed to set user agent, proceeding with default UA:', uaError);
                await page.setUserAgent('Mozilla/5.0');
            }

            // Optionally, set client IP as a header (if your GA4 code can read it)
            if (clientIp) {
                try {
                    await page.setExtraHTTPHeaders({ 'X-Forwarded-For': String(clientIp) });
                } catch (hdrError) {
                    console.error('Failed to set extra HTTP header X-Forwarded-For:', hdrError);
                }
            }

            // Enable caching
            await page.setCacheEnabled(true);

            // Block unnecessary resources
            await page.setRequestInterception(true);
            page.on('request', (req) => {
                const resourceType = req.resourceType();
                if (['image', 'stylesheet', 'font'].includes(resourceType)) {
                    req.abort();
                } else {
                    req.continue();
                }
            });

            // Set a timeout for Puppeteer's goto method
            const startTime = Date.now(); // Record start time
            await page.goto(targetUrl, { waitUntil: 'networkidle0', timeout: 120000 }); // 2 minute timeout
            let html = await page.content();
            const endTime = Date.now(); // Record end time
            const prerenderTime = endTime - startTime; // Calculate prerender time

            console.log(`Prerendered ${targetUrl} in ${prerenderTime}ms`);

            // Derive the base URL from the target URL
            const { protocol, host } = new urlModule.URL(targetUrl);
            const baseUrl = `${protocol}//${host}`;
            html = html.replace(/(href|src)="\/([^\"]*)"/g, `$1="${baseUrl}/$2"`);
            html = html.replace(/(href|src)="http:\/\/localhost:\d+\/([^\"]*)"/g, `$1="${baseUrl}/$2"`);

            prerenderCount++; // Increment the prerender count
            return html;
        } finally {
            // Ensure the page is closed after use
            await page.close();
        }
    } catch (error) {
        console.error(`Error prerendering ${targetUrl}:`, error);
        if (retryCount < 3) {
            console.log(`Retrying prerender ${targetUrl} (attempt ${retryCount + 1})...`);
            await new Promise(resolve => setTimeout(resolve, 1000)); // Wait 1 second before retrying
            // Pass userAgent and clientIp through on retries to avoid invalid parameter types
            return prerender(targetUrl, userAgent, clientIp, retryCount + 1); // Retry the prerender
        } else {
            console.error(`Max retries reached for ${targetUrl}.`);
            return null;
        }
    }
}

// Function to explicitly close the browser and its processes
async function closeBrowser() {
    if (browser) {
        try {
            console.log('Closing browser...');
            const browserProcess = browser.process();

            // Add a timeout to browser.close()
            await Promise.race([
                browser.close(),
                new Promise((_, reject) =>
                    setTimeout(() => reject(new Error('browser.close() timeout')), 30000) // 30 seconds timeout
                ),
            ]);

            console.log('Browser closed successfully.'); // Log success

            if (browserProcess) {
                console.log('Killing browser process...');
                browserProcess.kill('SIGKILL'); // Kill the browser process explicitly
                console.log('Browser process killed.'); // Log success
            }
        } catch (error) {
            console.error('Error closing browser:', error);
            // If browser.close() timed out, ensure the process is killed
            if (browser && browser.process()) {
                try {
                    console.log('Attempting to kill browser process due to timeout...');
                    browser.process().kill('SIGKILL');
                    console.log('Browser process killed after timeout.');
                } catch (killError) {
                    console.error('Error killing browser process after timeout:', killError);
                }
            }
        } finally {
            browser = null; // Ensure browser is nullified after closing
            console.log('Browser set to null.'); // Log nullification
            await cleanupZombieProcesses(); // Clean up zombie processes after closing
        }
    } else {
        console.log('Browser is already null, no need to close.');
    }
}

// Function to clean up zombie processes using Node.js process management
async function cleanupZombieProcesses() {
    if (cleanupRunning) {
        console.log('Cleanup already running, skipping...');
        return;
    }

    cleanupRunning = true;
    try {
        console.log('Cleaning up zombie processes...');
        const child = spawn('ps', ['-eo', 'pid,s,comm']); // Include state (s) in the output
        let output = '';

        child.stdout.on('data', (data) => {
            output += data.toString();
        });

        child.on('close', () => {
            const lines = output.split('\n');
            const zombieProcesses = lines.filter((line) => line.includes(' Z ') && line.includes('chrome')); // Look for ' Z ' state
            zombieProcesses.forEach((line) => {
                const parts = line.trim().split(/\s+/); // Split by any number of spaces
                const pid = parts[0];
                const state = parts[1];
                const command = parts.slice(2).join(' ');

                if (pid && state === 'Z') {
                    try {
                        console.log(`Attempting to kill zombie process with PID: ${pid}, Command: ${command}`);
                        process.kill(pid, 'SIGKILL'); // Kill the zombie process
                        console.log(`Killed zombie process with PID: ${pid}, Command: ${command}`);
                    } catch (error) {
                        console.error(`Failed to kill zombie process with PID: ${pid}, Command: ${command}`, error);
                    }
                }
            });
            cleanupRunning = false;
        });
    } catch (error) {
        console.error('Error cleaning up zombie processes:', error);
        cleanupRunning = false;
    }
}

// Periodic cleanup of zombie processes
setInterval(async () => {
    console.log('Running periodic cleanup of zombie processes...');
    await cleanupZombieProcesses();
}, 60000); // Run cleanup every 60 seconds

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

app.get('/render', async (req, res) => {
    console.log('Received request for prerendering:', req.query.url);

    const requestedUrl = req.query.url;
    const userAgent = req.headers['user-agent'] || 'Mozilla/5.0';
    const clientIp = req.headers['x-forwarded-for'] || req.ip;

    if (!requestedUrl) {
        console.log('Missing URL parameter');
        return res.status(400).send('Missing URL parameter');
    }

    try {
        const parsedUrl = new urlModule.URL(requestedUrl);
        console.log('Parsed URL:', parsedUrl.href);

        const prerenderedHtml = await prerender(requestedUrl, userAgent, clientIp);

        if (prerenderedHtml) {
            console.log('Prerendering successful');
            res.send(prerenderedHtml);
        } else {
            console.log('Prerendering failed');
            res.status(500).send('Prerendering failed');
        }
    } catch (error) {
        console.error('Error during prerendering:', error);
        res.status(400).send('Invalid URL');
    }
});

// Create a single instance of the proxy middleware
const proxyMiddleware = createProxyMiddleware({
    target: `http://localhost:${angularAppPort}`,
    changeOrigin: true,
});

// Use the proxy middleware for all unmatched routes
app.use('*', proxyMiddleware);

const server = app.listen(port, () => {
    console.log(`Prerender proxy server listening at http://localhost:${port}`);
});

// Increase the server timeout to handle long prerendering tasks
server.timeout = 120000; // 2 minutes
