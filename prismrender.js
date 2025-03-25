const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const puppeteer = require('puppeteer');
const urlModule = require('url');
// const { spawn } = require('child_process'); // Remove spawn import

const app = express();
const port = 3000;
const angularAppPort = 4200;

let browser; // Reuse a single browser instance
let browserRestartInterval = -1; // Restart browser after 10 prerender requests
let prerenderCount = 0;
let isRestarting = false; // Add a flag to indicate if the browser is restarting

async function launchBrowser() {
    if (!browser && !isRestarting) {
        isRestarting = true; // Set the flag to true before launching
        try {
            browser = await puppeteer.launch({
                headless: 'new',
                args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu'],
                protocolTimeout: 120000, // Increase protocol timeout to 2 minutes
            });
        } finally {
            isRestarting = false; // Reset the flag after launching (or failing to launch)
        }
    }
    return browser;
}

async function prerender(targetUrl) {
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

        if (!browser) { // Check if browser is null after launch
            console.log('Browser launch failed, skipping prerender');
            return null; // Skip prerendering if browser launch failed
        }

        const page = await browser.newPage();

        try {
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
            await page.goto(targetUrl, { waitUntil: 'networkidle0', timeout: 60000 }); // 1 minute timeout
            let html = await page.content();
            const endTime = Date.now(); // Record end time
            const prerenderTime = endTime - startTime; // Calculate prerender time

            console.log(`Prerendered ${targetUrl} in ${prerenderTime}ms`);

            // Derive the base URL from the target URL
            const { protocol, host } = new urlModule.URL(targetUrl);
            const baseUrl = `${protocol}//${host}`;
            html = html.replace(/(href|src)="\/([^"]*)"/g, `$1="${baseUrl}/$2"`);
            html = html.replace(/(href|src)="http:\/\/localhost:\d+\/([^"]*)"/g, `$1="${baseUrl}/$2"`);

            prerenderCount++; // Increment the prerender count
            return html;
        } finally {
            // Ensure the page is closed after use
            await page.close();
        }
    } catch (error) {
        console.error(`Error prerendering ${targetUrl}:`, error);
        return null;
    }
}

// Function to explicitly close the browser and its processes
async function closeBrowser() {
    if (browser) {
        try {
            console.log('Closing browser...');
            const browserProcess = browser.process();
            await browser.close(); // Close the browser instance
            if (browserProcess) {
                console.log('Killing browser process...');
                browserProcess.kill('SIGKILL'); // Kill the browser process explicitly
            }
        } catch (error) {
            console.error('Error closing browser:', error);
        } finally {
            browser = null; // Ensure browser is nullified after closing
        }
    }
}

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

app.get('/render', async (req, res) => {
    console.log('Received request for prerendering:', req.query.url);

    const requestedUrl = req.query.url;

    if (!requestedUrl) {
        console.log('Missing URL parameter');
        return res.status(400).send('Missing URL parameter');
    }

    try {
        const parsedUrl = new urlModule.URL(requestedUrl);
        console.log('Parsed URL:', parsedUrl.href);

        const prerenderedHtml = await prerender(requestedUrl);

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
