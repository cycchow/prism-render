const express = require('express');
const puppeteer = require('puppeteer');
const crypto = require('crypto');
const NodeCache = require('node-cache');
const { URL } = require('url');

const app = express();
const cache = new NodeCache({ stdTTL: 3600 }); // Cache responses for 1 hour

const generateCacheKey = (url) => {
    return crypto.createHash('md5').update(url).digest('hex');
};

app.get('*', async (req, res) => {
    const url = req.query.url;
    if (!url) {
        return res.status(400).send('Missing ?url parameter');
    }
    
    const cacheKey = generateCacheKey(url);
    const cachedResponse = cache.get(cacheKey);
    if (cachedResponse) {
        return res.send(cachedResponse);
    }
    
    try {
        const browser = await puppeteer.launch({ args: ['--no-sandbox'] });
        const page = await browser.newPage();
        await page.goto(url, { waitUntil: 'networkidle2' });
        
        // Fix relative URLs
        await page.evaluate((baseUrl) => {
            const fixUrl = (element, attr) => {
                if (element.hasAttribute(attr)) {
                    const value = element.getAttribute(attr);
                    if (value && !value.startsWith('http') && !value.startsWith('data:')) {
                        element.setAttribute(attr, new URL(value, baseUrl).href);
                    }
                }
            };
            document.querySelectorAll('a, link, script, img').forEach(el => {
                fixUrl(el, 'href');
                fixUrl(el, 'src');
            });
        }, url);
        
        const html = await page.content();
        await browser.close();
        
        cache.set(cacheKey, html);
        res.send(html);
    } catch (error) {
        res.status(500).send('Error rendering page');
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Prerender service running on port ${PORT}`));

