const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const puppeteer = require('puppeteer');
const urlModule = require('url');
const NodeCache = require('node-cache');

const app = express();
const port = Number(process.env.SERVER_PORT || process.env.PORT || 3000);
const angularAppPort = Number(process.env.ANGULAR_APP_PORT || 4200);
const isInternal = process.env.PRERENDER_INTERNAL === 'true';

const RENDER_CACHE_TTL_SECONDS = Number(process.env.RENDER_CACHE_TTL_SECONDS || 900);
const MAX_CONCURRENT_RENDERS = Number(process.env.MAX_CONCURRENT_RENDERS || 2);
const BROWSER_RESTART_INTERVAL = Number(process.env.BROWSER_RESTART_INTERVAL || 200);
const MAX_RENDER_RETRIES = Number(process.env.MAX_RENDER_RETRIES || 2);
const NAVIGATION_TIMEOUT_MS = Number(process.env.NAVIGATION_TIMEOUT_MS || 120000);
const RENDER_READY_TIMEOUT_MS = Number(process.env.RENDER_READY_TIMEOUT_MS || 60000);

const htmlCache = new NodeCache({
    stdTTL: RENDER_CACHE_TTL_SECONDS,
    useClones: false,
    checkperiod: Math.max(60, Math.floor(RENDER_CACHE_TTL_SECONDS / 2)),
});

let browser = null;
let browserPromise = null;
let prerenderCount = 0;
let activeRenders = 0;
const renderQueue = [];
const inFlightRenders = new Map();

function rewriteFrontendUrl(url) {
    if (!isInternal) {
        return url;
    }

    return url
        .replace('https://www.ma288.com', 'http://ma288-nginx.ma288-production.svc.cluster.local')
        .replace('https://ma288.com', 'http://ma288-nginx.ma288-production.svc.cluster.local');
}

function rewriteApiUrl(url) {
    if (!isInternal) {
        return url;
    }

    return url.replace('https://api.ma288.com', 'http://api-nginx.ma288-production.svc.cluster.local');
}

function normalizeHtml(targetUrl, html) {
    const { protocol, host } = new urlModule.URL(targetUrl);
    const baseUrl = `${protocol}//${host}`;

    return html
        .replace(/(href|src)="\/([^"]*)"/g, `$1="${baseUrl}/$2"`)
        .replace(/(href|src)="http:\/\/localhost:\d+\/([^"]*)"/g, `$1="${baseUrl}/$2"`);
}

function buildReadyCheck(targetUrl) {
    const pathname = new urlModule.URL(targetUrl).pathname;
    const rules = [];

    if (/^\/m\/(zh_hk|zh_cn|en)\/race-rating\/-999\/-999(?:\/\d{8})?$/.test(pathname)) {
        rules.push({ selector: 'div.panelHeader', minCount: 1 });
    } else if (/^\/m\/(zh_hk|zh_cn|en)\/race-rating\/[^/]+\/-999\/\d{8}$/.test(pathname)) {
        rules.push({ selector: 'div.ma288promote', minCount: 1 });
    } else if (/^\/m\/(zh_hk|zh_cn|en)\/race-rating\/[^/]+\/[^/]+\/\d{8}$/.test(pathname)) {
        rules.push({ selector: 'article h1' });
    } else if (/^\/m\/(zh_hk|zh_cn|en)\/oversea-race$/.test(pathname)) {
        rules.push({ selector: 'a[href*="tipsAction_getFormRating"]', minCount: 3 });
    } else if (/^\/register\/(zh_hk|zh_cn|en)\/select-plan$/.test(pathname)) {
        rules.push({ selector: 'h2', textIncludes: ['我們的服務計劃', '我们的服务计划', 'Our Plans', 'Our Service Plans'] });
    }

    return rules;
}

async function acquireRenderSlot() {
    if (activeRenders < MAX_CONCURRENT_RENDERS) {
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

async function launchBrowser() {
    if (browser && browser.isConnected()) {
        return browser;
    }

    if (!browserPromise) {
        browserPromise = puppeteer.launch({
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-gpu',
                '--disable-dev-shm-usage',
                '--no-zygote',
            ],
            protocolTimeout: 120000,
        }).then((instance) => {
            instance.on('disconnected', () => {
                browser = null;
                browserPromise = null;
            });

            browser = instance;
            return instance;
        }).catch((error) => {
            browserPromise = null;
            throw error;
        });
    }

    return browserPromise;
}

async function closeBrowser() {
    const currentBrowser = browser;
    browser = null;
    browserPromise = null;

    if (!currentBrowser) {
        return;
    }

    try {
        await Promise.race([
            currentBrowser.close(),
            new Promise((_, reject) => setTimeout(() => reject(new Error('browser.close() timeout')), 10000)),
        ]);
    } catch (error) {
        const browserProcess = currentBrowser.process();
        if (browserProcess && !browserProcess.killed) {
            browserProcess.kill('SIGKILL');
        }
    }
}

async function withPage(task) {
    const currentBrowser = await launchBrowser();
    const page = await currentBrowser.newPage();

    await page.setCacheEnabled(true);
    await page.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT_MS);
    await page.setDefaultTimeout(RENDER_READY_TIMEOUT_MS);
    await page.setRequestInterception(true);

    page.on('request', (req) => {
        const requestUrl = req.url();
        const resourceType = req.resourceType();

        if (
            requestUrl.includes('googletagmanager.com') ||
            requestUrl.includes('google-analytics.com') ||
            requestUrl.includes('analytics.google.com') ||
            requestUrl.includes('gtag/js') ||
            requestUrl.includes('collect?v=') ||
            requestUrl.includes('stats.g.doubleclick.net')
        ) {
            return req.abort();
        }

        if (requestUrl.startsWith('https://www.ma288.com') || requestUrl.startsWith('https://ma288.com')) {
            return req.continue({
                url: rewriteFrontendUrl(requestUrl),
                headers: {
                    ...req.headers(),
                    'X-Prerender-Request': '1',
                },
            });
        }

        if (requestUrl.startsWith('https://api.ma288.com')) {
            return req.continue({ url: rewriteApiUrl(requestUrl) });
        }

        if (['image', 'font', 'media', 'manifest'].includes(resourceType)) {
            return req.abort();
        }

        return req.continue();
    });

    try {
        return await task(page);
    } finally {
        await page.close().catch(() => {});
    }
}

async function renderOnce(targetUrl) {
    if (BROWSER_RESTART_INTERVAL > 0 && prerenderCount >= BROWSER_RESTART_INTERVAL) {
        await closeBrowser();
        prerenderCount = 0;
    }

    const startTime = Date.now();
    const gotoUrl = rewriteFrontendUrl(targetUrl);

    const html = await withPage(async (page) => {
        await page.goto(gotoUrl, {
            waitUntil: 'networkidle2',
            timeout: NAVIGATION_TIMEOUT_MS,
        });

        const rules = buildReadyCheck(targetUrl);

        await page.waitForFunction(
            (readyRules) => {
                const root = document.querySelector('app-root');
                if (!root) {
                    return false;
                }

                const rootText = root.innerText.replace(/\s+/g, ' ').trim();
                if (!rootText) {
                    return false;
                }

                if (!readyRules || readyRules.length === 0) {
                    return true;
                }

                return readyRules.every((rule) => {
                    const elements = Array.from(document.querySelectorAll(rule.selector));
                    if (elements.length === 0) {
                        return false;
                    }

                    if (rule.minCount && elements.length < rule.minCount) {
                        return false;
                    }

                    const texts = elements
                        .map((element) => element.textContent.replace(/\s+/g, ' ').trim())
                        .filter(Boolean);

                    if (texts.length === 0) {
                        return false;
                    }

                    if (rule.textIncludes && rule.textIncludes.length > 0) {
                        return rule.textIncludes.some((expectedText) =>
                            texts.some((text) => text.includes(expectedText))
                        );
                    }

                    return true;
                });
            },
            { timeout: RENDER_READY_TIMEOUT_MS },
            rules
        );

        return page.content();
    });

    prerenderCount += 1;
    console.log(`Prerendered ${targetUrl} in ${Date.now() - startTime}ms`);
    return normalizeHtml(targetUrl, html);
}

async function prerender(targetUrl, retryCount = 0) {
    const cachedHtml = htmlCache.get(targetUrl);
    if (cachedHtml) {
        return cachedHtml;
    }

    const existingRender = inFlightRenders.get(targetUrl);
    if (existingRender) {
        return existingRender;
    }

    const renderPromise = (async () => {
        await acquireRenderSlot();
        try {
            const html = await renderOnce(targetUrl);
            htmlCache.set(targetUrl, html);
            return html;
        } catch (error) {
            console.error(`Error prerendering ${targetUrl}:`, error);
            await closeBrowser();

            if (retryCount < MAX_RENDER_RETRIES) {
                await new Promise((resolve) => setTimeout(resolve, 500 * (retryCount + 1)));
                return prerender(targetUrl, retryCount + 1);
            }

            return null;
        } finally {
            releaseRenderSlot();
            inFlightRenders.delete(targetUrl);
        }
    })();

    inFlightRenders.set(targetUrl, renderPromise);
    return renderPromise;
}

app.get('/health', (_req, res) => {
    res.status(200).json({
        ok: true,
        browserConnected: Boolean(browser && browser.isConnected()),
        activeRenders,
        queuedRenders: renderQueue.length,
        cacheKeys: htmlCache.keys().length,
    });
});

app.get('/render', async (req, res) => {
    const requestedUrl = req.query.url;

    if (!requestedUrl) {
        return res.status(400).send('Missing URL parameter');
    }

    try {
        const parsedUrl = new urlModule.URL(requestedUrl);
        if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
            return res.status(400).send('Invalid URL');
        }

        const prerenderedHtml = await prerender(parsedUrl.href);
        if (!prerenderedHtml) {
            return res.status(500).send('Prerendering failed');
        }

        res.set('Content-Type', 'text/html; charset=utf-8');
        return res.send(prerenderedHtml);
    } catch (_error) {
        return res.status(400).send('Invalid URL');
    }
});

const proxyMiddleware = createProxyMiddleware({
    target: `http://localhost:${angularAppPort}`,
    changeOrigin: true,
});

app.use(proxyMiddleware);

const server = app.listen(port, () => {
    console.log(`Prerender proxy server listening at http://localhost:${port}`);
});

server.timeout = 120000;

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
process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

module.exports = {
    closeBrowser,
};
