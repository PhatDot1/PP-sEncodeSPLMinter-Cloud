// CloudPt2.ts

import 'dotenv/config';
import Airtable from 'airtable';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { Metaplex, keypairIdentity } from '@metaplex-foundation/js';

const {
  AIRTABLE_API_KEY,
  BASE_ID,
  TABLE_NAME,
  QUICKNODE_RPC,
  SOLANA_SECRET_KEY
} = process.env!;

if (!AIRTABLE_API_KEY || !BASE_ID || !TABLE_NAME || !QUICKNODE_RPC || !SOLANA_SECRET_KEY) {
  throw new Error('Missing one of AIRTABLE_API_KEY, BASE_ID, TABLE_NAME, QUICKNODE_RPC or SOLANA_SECRET_KEY');
}

const base       = new Airtable({ apiKey: AIRTABLE_API_KEY }).base(BASE_ID);
const connection = new Connection(QUICKNODE_RPC, { commitment: 'finalized' });
const wallet     = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(SOLANA_SECRET_KEY)));
const metaplex   = Metaplex.make(connection).use(keypairIdentity(wallet));

interface Fields {
  'Certificate Status': string;
  'Candy Machine ID':    string;
  'IPFS Metadata':       string;
  'Certificate ID':      string;
  'Link to NFT'?:        string;
}

async function fetchOne(): Promise<Airtable.Record<Airtable.FieldSet> | null> {
  const [rec] = await base(TABLE_NAME!)
    .select({
      filterByFormula: "{Certificate Status}='SPL Loaded'",
      maxRecords: 1
    })
    .firstPage();
  return rec || null;
}

(async () => {
  const rec = await fetchOne();
  if (!rec) {
    console.log('No SPL Loaded records → nothing to mint.');
    return;
  }

  const f      = rec.fields as unknown as Fields;
  const cmId   = f['Candy Machine ID'];
  const certId = f['Certificate ID'];

  if (!cmId || !certId) {
    console.error(`Record ${rec.id} missing Candy Machine ID or Certificate ID`);
    return;
  }

  // load machine
  const candyMachine = await metaplex
    .candyMachines()
    .findByAddress({ address: new PublicKey(cmId) });

  // mint only (no insertItems)
  const { nft } = await metaplex
    .candyMachines()
    .mint(
       { candyMachine, collectionUpdateAuthority: wallet.publicKey },
       { commitment: 'finalized' }
    );

  const link = `https://explorer.solana.com/address/${nft.address.toBase58()}?cluster=mainnet-beta`;

  // Update Airtable
  await base(TABLE_NAME).update(rec.id, {
    'Link to NFT':        link,
    'Certificate Status': 'SPL Minted'
  });

  console.log(`✅ Minted & updated record ${rec.id}`);
})();
