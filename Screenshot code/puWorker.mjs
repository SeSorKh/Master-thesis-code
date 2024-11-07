import puppeteer from 'puppeteer-core';
import chromium from '@sparticuz/chromium-min';
import AWS from 'aws-sdk';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';

// Promisify fs functions
const readdir = promisify(fs.readdir);
const rm = promisify(fs.rm);

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Set up AWS S3 with explicit region configuration
const s3 = new AWS.S3({
    region: 'eu-west-3' // Set to your S3 bucket's region
});

const uploadToS3 = async (buffer, bucketName, key) => {
    const params = {
        Bucket: bucketName,
        Key: key,
        Body: buffer,
        ContentType: 'image/png'
    };

    try {
        const data = await s3.upload(params).promise();
        console.log(`File uploaded successfully at ${data.Location}`);
        return data.Location;
    } catch (error) {
        console.error('Error uploading to S3:', error);
        throw error;
    }
};

// Clean up temporary files and directories
const cleanUpTempFiles = async (tempDir) => {
    console.log('Cleaning up temporary files...');
    try {
        const files = await readdir(tempDir);
        for (const file of files) {
            if (file.startsWith('puppeteer_dev_chrome_profile')) {
                console.log(`Removing file: ${file}`);
                await rm(path.join(tempDir, file), { recursive: true, force: true });
            }
        }
    } catch (err) {
        console.error('Error cleaning up temporary files:', err);
    }
};

const logMemoryUsage = (label) => {
    const memoryUsage = process.memoryUsage();
    console.log(`${label} - Memory Usage: RSS: ${(memoryUsage.rss / 1024 / 1024).toFixed(2)} MB, HeapTotal: ${(memoryUsage.heapTotal / 1024 / 1024).toFixed(2)} MB, HeapUsed: ${(memoryUsage.heapUsed / 1024 / 1024).toFixed(2)} MB, External: ${(memoryUsage.external / 1024 / 1024).toFixed(2)} MB`);
};

(async () => {
    try {
        const inpDataB64 = process.argv.find((a) => a.startsWith('--input-data')).replace('--input-data=', '');
        const inputData = JSON.parse(Buffer.from(inpDataB64, 'base64').toString());

        const apiKey = inputData.apiKey;
        const url = inputData.url;

        logMemoryUsage('Handler Start');

        console.log('Launching browser...');
        const browser = await puppeteer.launch({
            args: [
                ...chromium.args,
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-infobars',
                '--disable-web-security',
                '--disable-features=IsolateOrigins,site-per-process',
                '--disable-site-isolation-trials',
                '--disable-features=BlockInsecurePrivateNetworkRequests'
            ],
            defaultViewport: chromium.defaultViewport,
            executablePath: await chromium.executablePath(
                'https://github.com/SeSorKh/Chromium-Aws/raw/main/chromium-v123.0.1-pack.tar'
            ),
            headless: true, // Use headless mode for faster execution
            ignoreHTTPSErrors: true,
        });

        logMemoryUsage('After Browser Launch');

        const page = await browser.newPage();

        let navigationRetries = 3;
        while (navigationRetries > 0) {
            try {
                await page.goto(url, { waitUntil: 'domcontentloaded' });
                console.log('Page loaded');
                await sleep(6000); // Wait for 6 seconds to ensure the page is fully loaded
                break; // Navigation succeeded
            } catch (error) {
                console.error(`Error navigating: ${error.message}`);
                if (error.message.includes('Navigating frame was detached') && navigationRetries > 0) {
                    console.log('Retrying navigation...');
                    navigationRetries--;
                    await sleep(2000); // Wait before retrying
                } else {
                    throw error; // Other errors should not be retried
                }
            }
        }

        logMemoryUsage('Before Screenshot');

        // Take screenshot
        const screenshotBuffer = await page.screenshot({ fullPage: true });

        // Upload screenshot to S3
        const bucketName = 'screenshot-storage'; // S3 bucket name
        const s3Key = `${apiKey}/screenshots/screenshot-${Date.now()}.png`; // Store in folder named by API key

        const s3Url = await uploadToS3(screenshotBuffer, bucketName, s3Key);

        logMemoryUsage('After Screenshot and S3 Upload');

        console.log(`Screenshot URL: ${s3Url}`);

        logMemoryUsage('Before Closing Pages');

        // Close individual pages
        const pages = await browser.pages();
        await Promise.all(pages.map(page => page.close()));

        logMemoryUsage('After Closing Pages');

        // Increase the timeout for browser closure if necessary
        const browserCloseTimeout = new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                reject(new Error('Browser close timeout'));
            }, 10000); // Increased timeout

            browser.close().then(() => {
                clearTimeout(timeout);
                resolve();
            }).catch((error) => {
                clearTimeout(timeout);
                reject(error);
            });
        });

        try {
            await browserCloseTimeout;
            console.log('Browser closed successfully.');
        } catch (error) {
            console.error('Error during browser close:', error.message);
            const browserProcess = browser.process();
            if (browserProcess) {
                browserProcess.kill();
                console.log('Browser process killed.');
            }
        }

        process.send({ screenshotUrl: s3Url });
        process.exit(0);
    } catch (error) {
        console.error('Error:', error);
        process.send({ error: JSON.stringify(error, Object.getOwnPropertyNames(error)) });
        process.exit(1);
    } finally {
        logMemoryUsage('Before Process Exit');
        // Clean up temporary files
        await cleanUpTempFiles('/tmp');
    }
})();
