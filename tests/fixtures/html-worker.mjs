import { parentPort, workerData } from 'node:worker_threads';
import { tsImport } from 'tsx/esm/api';

// Load the production implementation; the parent can terminate a blocked conversion.
const { htmlToText } = await tsImport('../../src/ado/bounded.ts', import.meta.url);
const input = workerData === 'angles' ? '<'.repeat(1_000_000)
  : workerData === 'list-items' ? '<li '.repeat(250_000)
  : `a${' '.repeat(1_000_000)}b`;
const output = htmlToText(input);
parentPort.postMessage({ length: output.length, ok: output === input.trim() });
