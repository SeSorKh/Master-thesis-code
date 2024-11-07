import { fork } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

// Define __dirname for ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const handler = async (event) => {
    console.time('Total time');
    console.log('Handler function started');
    console.log(`Handler Start - Memory Usage: RSS: ${process.memoryUsage().rss / 1048576} MB, HeapTotal: ${process.memoryUsage().heapTotal / 1048576} MB, HeapUsed: ${process.memoryUsage().heapUsed / 1048576} MB, External: ${process.memoryUsage().external / 1048576} MB`);
    
    const body = JSON.parse(event.body);
    const url = body.url;
    const apiKey = body.apiKey;

    if (!url || !apiKey) {
        console.timeEnd('Total time');
        console.error('URL and API key are required');
        return {
            statusCode: 400,
            body: JSON.stringify({ error: "URL and API key are required" }),
        };
    }

    const childProcessPath = path.resolve(__dirname, 'puWorker.mjs');

    return new Promise((resolve, reject) => {
        const child = fork(childProcessPath, [`--input-data=${Buffer.from(JSON.stringify({ url, apiKey })).toString('base64')}`]);

        child.on('message', (message) => {
            console.timeEnd('Total time');
            if (message.error) {
                reject({
                    statusCode: 500,
                    body: JSON.stringify({ error: message.error }),
                });
            } else {
                resolve({
                    statusCode: 200,
                    body: JSON.stringify(message),
                });
            }
            console.log(`After Child Process Message - Memory Usage: RSS: ${process.memoryUsage().rss / 1048576} MB, HeapTotal: ${process.memoryUsage().heapTotal / 1048576} MB, HeapUsed: ${process.memoryUsage().heapUsed / 1048576} MB, External: ${process.memoryUsage().external / 1048576} MB`);
        });

        child.on('error', (error) => {
            console.timeEnd('Total time');
            reject({
                statusCode: 500,
                body: JSON.stringify({ error: error.message }),
            });
        });

        child.on('exit', (code) => {
            if (code !== 0) {
                console.timeEnd('Total time');
                reject({
                    statusCode: 500,
                    body: JSON.stringify({ error: `Child process exited with code ${code}` }),
                });
            }
            console.log(`Before Process Exit - Memory Usage: RSS: ${process.memoryUsage().rss / 1048576} MB, HeapTotal: ${process.memoryUsage().heapTotal / 1048576} MB, HeapUsed: ${process.memoryUsage().heapUsed / 1048576} MB, External: ${process.memoryUsage().external / 1048576} MB`);
        });
    });
};
