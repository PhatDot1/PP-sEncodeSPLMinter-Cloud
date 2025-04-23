// wrapped in outer polling loop rather than continuous runs, to force compatibility with app platform

import 'dotenv/config';
import Airtable from 'airtable';
import { exec as _exec } from 'child_process';
import { promisify } from 'util';

const exec = promisify(_exec);

const {
  AIRTABLE_API_KEY,
  BASE_ID,
  TABLE_NAME
} = process.env;

if (!AIRTABLE_API_KEY || !BASE_ID || !TABLE_NAME) {
  console.error('Missing one of AIRTABLE_API_KEY, BASE_ID or TABLE_NAME in .env');
  process.exit(1);
}

const base = new Airtable({ apiKey: AIRTABLE_API_KEY }).base(BASE_ID);

async function countByStatus(status: string): Promise<number> {
  const recs = await base(TABLE_NAME!)
    .select({ filterByFormula: `{Certificate Status}='${status}'`, pageSize: 100 })
    .firstPage();
  return recs.length;
}

async function runScript(script: string) {
  console.log(`\n▶️  Running ${script}`);
  const { stdout, stderr } = await exec(`ts-node ${script}`);
  if (stdout) console.log(stdout.trim());
  if (stderr) console.error(stderr.trim());
}

function sleep(ms: number) {
  return new Promise<void>(r => setTimeout(r, ms));
}

// one full pass through all three parts
async function cycle() {
  // Part 1: batch Ready Sol → SPL Loaded
  while (await countByStatus('Ready Sol') > 0) {
    console.log(`\n🔥 ${await countByStatus('Ready Sol')} Ready Sol → processing batch…`);
    await runScript('CloudPt1.ts');
    await sleep(30_000);
  }
  console.log('✅ No more Ready Sol.');

  // Part 2: mint SPL Loaded → SPL Minted
  while (await countByStatus('SPL Loaded') > 0) {
    console.log(`\n🔨 ${await countByStatus('SPL Loaded')} SPL Loaded → minting one…`);
    await runScript('CloudPt2.ts');
    await sleep(30_000);
  }
  console.log('✅ No more SPL Loaded.');

  // Part 3: transfer/email SPL Minted
  while (await countByStatus('SPL Minted') > 0) {
    console.log(`\n✉️ ${await countByStatus('SPL Minted')} SPL Minted → transferring one…`);
    await runScript('CloudPt3.ts');
    await sleep(30_000);
  }
  console.log('✅ No more SPL Minted.');
}

(async () => {
  console.log('🛡️  Orchestrator started, polling every 60 s.');
  while (true) {
    try {
      await cycle();
    } catch (err) {
      console.error('❌ Orchestrator cycle error:', err);
    }
    console.log('\n⏱  Waiting 60 s before next full cycle…');
    await sleep(60_000);
  }
})();
