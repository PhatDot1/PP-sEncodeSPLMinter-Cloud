// orchestrator.ts

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
  return new Promise(r => setTimeout(r, ms));
}

(async () => {
  try {
    // Part 1: batch through Ready Sol → SPL Loaded
    while (await countByStatus('Ready Sol') > 0) {
      console.log(`\n🔥 ${await countByStatus('Ready Sol')} Ready Sol remaining → processing batch…`);
      await runScript('CloudPt1.ts');
      console.log('Waiting 30 s before next batch…');
      await sleep(30_000);
    }
    console.log('✅ All Ready Sol batches done.');

    // Part 2: mint one‑by‑one SPL Loaded → SPL Minted
    while (await countByStatus('SPL Loaded') > 0) {
      console.log(`\n🔨 ${await countByStatus('SPL Loaded')} SPL Loaded remaining → minting one…`);
      await runScript('CloudPt2.ts');
      console.log('Waiting 30 s before next mint…');
      await sleep(30_000);
    }
    console.log('✅ All SPL Loaded minting done.');

    // Part 3: transfer & email one‑by‑one SPL Minted → Success
    while (await countByStatus('SPL Minted') > 0) {
      console.log(`\n✉️ ${await countByStatus('SPL Minted')} SPL Minted remaining → transferring one…`);
      await runScript('CloudPt3.ts');
      console.log('Waiting 30 s before next transfer…');
      await sleep(30_000);
    }
    console.log('\n🎉 All done through Part 3!');
  } catch (err) {
    console.error('❌ Orchestrator error:', err);
    process.exit(1);
  }
})();
