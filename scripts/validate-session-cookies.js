import { readFileSync } from 'node:fs';
import { parseSessionCookies } from '../src/lib/runtime-inputs.js';

try {
  parseSessionCookies(readFileSync(process.argv[2], 'utf8'));
} catch {
  console.error('Fresh session cookies are required; cookie generation did not produce a valid CSV');
  process.exit(1);
}
