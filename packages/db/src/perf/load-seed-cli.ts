import { loadPerfEnv } from '../env.js';
import { main } from './load-seed.js';

await main(process.argv.slice(2), loadPerfEnv().adminUrl);
