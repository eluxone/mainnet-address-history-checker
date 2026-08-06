import { copyFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = resolve(projectRoot, 'node_modules/ethers/dist/ethers.umd.min.js');
const destinationDirectory = resolve(projectRoot, 'vendor');
const destination = resolve(destinationDirectory, 'ethers.umd.min.js');

await mkdir(destinationDirectory, { recursive: true });
await copyFile(source, destination);
console.log('Copied ethers browser bundle to vendor/ethers.umd.min.js');
