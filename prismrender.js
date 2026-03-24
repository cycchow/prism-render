const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const puppeteer = require('puppeteer');
const urlModule = require('url');
const { spawn } = require('child_process'); // Import spawn to handle zombie processes

const app = express();
const port = process.env.SERVER_PORT || 3000;
const angularAppPort = 4200;
const isInternal = process.env.PRERENDER_INTERNAL === "true";

let browser; // Reuse a single browser instance
let browserRestartInterval = 60; // Restart browser every 60 requests
let prerenderCount = 0;
let isRestarting = false; // Add a flag to indicate if the browser is restarting
let cleanupRunning = false; // Flag to prevent concurrent cleanup
const maxConcurrentRenders = Number(process.env.MAX_CONCURRENT_RENDERS || 1);
let activeRenders = 0;
const renderQueue = [];

function buildReadyRules(targetUrl) {
    const pathname = new urlModule.URL(targetUrl).pathname;

    if (/^\/m\/(zh_hk|zh_cn|en)\/race-rating\/-999\/-999(?:\/\d{8})?$/.test(pathname)) {
        return [{ selector: 'div.panelHeader' }];
    }

    if (/^\/m\/(zh_hk|zh_cn|en)\/race-rating\/[^/]+\/-999\/\d{8}$/.test(pathname)) {
        return [{ selector: 'div.ma288promote' }];
    }

    if (/^\/m\/(zh_hk|zh_cn|en)\/race-rating\/[^/]+\/[^/]+\/\d{8}$/.test(pathname)) {
        return [{ selector: 'article h1' }];
    }

    if (/^\/m\/(zh_hk|zh_cn|en)\/oversea-race$/.test(pathname)) {
        return [{ selector: 'a[href*="tipsAction_getFormRating"]', minCount: 1 }];
    }

    if (/^\/register\/(zh_hk|zh_cn|en)\/select-plan$/.test(pathname)) {
        return [{
            selector: 'h2',
            textIncludes: ['我們的服務計劃', '我们的服务计划', 'Our Plans', 'Our Service Plans'],
        }];
    }

    return [];
}

async function launchBrowser() {
    if (!browser && !isRestarting) {
        isRestarting = true; // Set the flag to true before launching
        try {
            console.log('Launching browser...');
            browser = await puppeteer.launch({
                headless: 'new',
                // headless: false,
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

function cleanupPrerenderedHtml(html) {
    return html
        .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
        .replace(/<link\b[^>]*rel=["']manifest["'][^>]*>/gi, '');
}

async function acquireRenderSlot() {
    if (activeRenders < maxConcurrentRenders) {
        activeRenders += 1;
        return;
    }

    await new Promise((resolve) => renderQueue.push(resolve));
    activeRenders += 1;
}

function releaseRenderSlot() {
    activeRenders = Math.max(0, activeRenders - 1);
    const next = renderQueue.shift();
    if (next) {
        next();
    }
}

async function prerender(targetUrl, retryCount = 0) {
    await acquireRenderSlot();
    try {
        // Determine whether to rewrite URLs internally (for in-cluster rendering)


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
            page.on('pageerror', (error) => {
                console.error('[browser:PAGEERROR]', error);
            });

            page.on('console', (message) => {
                const text = message.text();
                if (
                    message.type() === 'error' &&
                    text !== 'Failed to load resource: net::ERR_FAILED'
                ) {
                    console.error(`[browser:ERROR] ${text}`);
                }
            });

            page.on('requestfailed', (req) => {
                if (req.url().includes('api.ma288.com')) {
                    const failure = req.failure();
                    console.error(
                        `[browser:REQUESTFAILED] ${req.method()} ${req.url()} ${failure ? failure.errorText : 'unknown error'}`
                    );
                }
            });

            page.on('response', (response) => {
                const requestUrl = response.url();
                if (requestUrl.includes('api.ma288.com') && response.status() >= 400) {
                    console.error(`[browser:HTTP${response.status()}] ${response.request().method()} ${requestUrl}`);
                }
            });

            // Enable caching
            await page.setCacheEnabled(true);

            // --- ENABLE request interception and use custom handler ---
            await page.setRequestInterception(true);
            page.on('request', (req) => {
                const url = req.url();
                const resourceType = req.resourceType();

                // --- (1) BLOCK ALL GA / GTM / ANALYTICS ---
                if (
                    url.includes('googletagmanager.com') ||
                    url.includes('google-analytics.com') ||
                    url.includes('analytics.google.com') ||
                    url.includes('gtag/js') ||
                    url.includes('collect?v=') ||
                    url.includes('stats.g.doubleclick.net')
                ) {
                    return req.abort();
                }

                // --- (2) REWRITE FRONTEND DOMAIN TO INTERNAL K8S SERVICE ---
                if (url.startsWith("https://www.ma288.com") || url.startsWith("https://ma288.com")) {
                    const internalUrl = url
                        .replace("https://www.ma288.com", isInternal?"http://ma288-nginx.ma288-production.svc.cluster.local":"https://www.ma288.com")
                        .replace("https://ma288.com", isInternal?"http://ma288-nginx.ma288-production.svc.cluster.local":"https://ma288.com")

                        ;

                        return req.continue({ url: internalUrl });
                }

                // --- (3) REWRITE API DOMAIN TO INTERNAL K8S SERVICE ---
                if (url.startsWith("https://api.ma288.com")) {
                    const internalApiUrl = url
                        .replace("https://api.ma288.com",isInternal?"http://api-nginx.ma288-production.svc.cluster.local":"https://api.ma288.com")
                    ;
                    return req.continue({ url: internalApiUrl });
                }

                // BLOCK USELESS RESOURCES (KEEP JS ALLOWED)
                if (resourceType === "script") {
                    return req.continue(); // ALWAYS allow JS bundles (critical for Angular)
                }

                if (["image", "font"].includes(resourceType)) {
                    return req.abort();
                }

                req.continue();
            });

            // Set a timeout for Puppeteer's goto method
            const startTime = Date.now(); // Record start time
            
            // Rewrite main navigation URL only when running inside cluster
            let gotoUrl = targetUrl;
            if (isInternal) {
                gotoUrl = gotoUrl
                    .replace("https://www.ma288.com", "http://ma288-nginx.ma288-production.svc.cluster.local")
                    .replace("https://ma288.com", "http://ma288-nginx.ma288-production.svc.cluster.local");
            }

            await page.goto(gotoUrl, {
                waitUntil: 'networkidle2',
                timeout: 120000
            });
            
            // Wait until Angular has rendered something meaningful
            const readyRules = buildReadyRules(targetUrl);
            await page.waitForFunction(
                (rules) => {
                    const root = document.querySelector('app-root');
                    if (!root || root.innerText.trim().length === 0) {
                        return false;
                    }

                    if (!rules || rules.length === 0) {
                        return true;
                    }

                    return rules.every((rule) => {
                        const elements = Array.from(document.querySelectorAll(rule.selector));
                        if (elements.length === 0) {
                            return false;
                        }

                        if (rule.minCount && elements.length < rule.minCount) {
                            return false;
                        }

                        if (rule.textIncludes && rule.textIncludes.length > 0) {
                            return elements.some((element) => {
                                const text = element.textContent.trim();
                                return rule.textIncludes.some((expected) => text.includes(expected));
                            });
                        }

                        return elements.some((element) => element.textContent.trim().length > 0);
                    });
                },
                { timeout: 60000 },
                readyRules
            );

            let html = await page.content();
            const endTime = Date.now(); // Record end time
            const prerenderTime = endTime - startTime; // Calculate prerender time

            console.log(`Prerendered ${targetUrl} in ${prerenderTime}ms`);

            // Derive the base URL from the target URL
            const { protocol, host } = new urlModule.URL(targetUrl);
            const baseUrl = `${protocol}//${host}`;
            html = html.replace(/(href|src)="\/([^"]*)"/g, `$1="${baseUrl}/$2"`);
            html = html.replace(/(href|src)="http:\/\/localhost:\d+\/([^"]*)"/g, `$1="${baseUrl}/$2"`);
            html = cleanupPrerenderedHtml(html);

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
            return prerender(targetUrl, retryCount + 1); // Retry the prerender
        } else {
            console.error(`Max retries reached for ${targetUrl}.`);
            return null;
        }
    } finally {
        releaseRenderSlot();
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

app.get('/health', (_req, res) => {
    res.status(200).json({
        ok: true,
        browserConnected: Boolean(browser && browser.isConnected && browser.isConnected()),
        activeRenders,
        queuedRenders: renderQueue.length,
        maxConcurrentRenders,
    });
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
    launchBrowser().catch((error) => {
        console.error('Browser prelaunch failed:', error);
    });
});

// Increase the server timeout to handle long prerendering tasks
server.timeout = 120000; // 2 minutes

async function shutdown(signal) {
    console.log(`Received ${signal}, shutting down...`);
    server.close(async () => {
        await closeBrowser();
        process.exit(0);
    });

    setTimeout(() => {
        process.exit(1);
    }, 15000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
