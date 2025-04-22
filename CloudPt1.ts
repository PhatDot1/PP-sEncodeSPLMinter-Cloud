// CloudPt1.ts

import 'dotenv/config';
import Airtable from 'airtable';
import axios from 'axios';
import FormData from 'form-data';
import fs from 'fs';
import path from 'path';
import Jimp from 'jimp';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import {
  Metaplex,
  keypairIdentity,
  toBigNumber,
  DefaultCandyGuardSettings,
  CreateCandyMachineInput
} from '@metaplex-foundation/js';

// ─── ENV & CONFIG ───────────────────────────────────────────────────────────────
const {
  AIRTABLE_API_KEY,
  BASE_ID,
  TABLE_NAME,
  QUICKNODE_RPC,
  SOLANA_SECRET_KEY,
  PINATA_API_KEY,
  PINATA_SECRET_API_KEY,
  COLLECTION_MINT,
  LOAD_NUMBER = '8',
} = process.env;

if (!AIRTABLE_API_KEY || !BASE_ID || !TABLE_NAME ||
    !QUICKNODE_RPC || !SOLANA_SECRET_KEY ||
    !PINATA_API_KEY || !PINATA_SECRET_API_KEY ||
    !COLLECTION_MINT) {
  console.error('Missing one of AIRTABLE_API_KEY, BASE_ID, TABLE_NAME, QUICKNODE_RPC, SOLANA_SECRET_KEY, PINATA_API_KEY, PINATA_SECRET_API_KEY or COLLECTION_MINT in .env');
  process.exit(1);
}

const BATCH_SIZE = parseInt(LOAD_NUMBER, 10);

// Paths for fonts and your screen_positions enum
const FONT_REGULAR_PATH  = path.join(__dirname, 'fonts', 'Montserrat-Regular.fnt');
const FONT_SEMIBOLD_PATH = path.join(__dirname, 'fonts', 'Montserrat-SemiBold.fnt');
const screen_positions   = require('./enums');

// ─── Airtable & Solana clients ─────────────────────────────────────────────────
const base       = new Airtable({ apiKey: AIRTABLE_API_KEY }).base(BASE_ID);
const connection = new Connection(QUICKNODE_RPC, { commitment: 'finalized' });
const secretKey  = Uint8Array.from(JSON.parse(SOLANA_SECRET_KEY));
const wallet     = Keypair.fromSecretKey(secretKey);
const metaplex   = Metaplex.make(connection).use(keypairIdentity(wallet));

// ─── Types ───────────────────────────────────────────────────────────────────────
interface Fields {
  'Certificate Status': string;
  'Certificate image (from 📺 Programmes)': { url: string }[];
  'Programme name (from 📺 Programmes)': string[];
  'Achievement level': string;
  'Certificate ID': string;
  // we’ll write these:
  'IPFS Image'?: string;
  'IPFS Metadata'?: string;
  'Candy Machine ID'?: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────────

// 1. Fetch up to BATCH_SIZE “Ready Sol” records
async function fetchBatch() {
  return base(TABLE_NAME!)
    .select({
      filterByFormula: "{Certificate Status}='Ready Sol'",
      maxRecords: BATCH_SIZE,
    })
    .firstPage() as Promise<Airtable.Record<Airtable.FieldSet>[]>;
}

// 2. Upload image buffer to Pinata
async function uploadToPinata(buffer: Buffer, filename: string) {
  const url = 'https://api.pinata.cloud/pinning/pinFileToIPFS';
  const data = new FormData();
  data.append('file', buffer, filename);
  const resp = await axios.post(url, data, {
    headers: {
      ...data.getHeaders(),
      pinata_api_key: PINATA_API_KEY!,
      pinata_secret_api_key: PINATA_SECRET_API_KEY!
    }
  });
  return `https://ipfs.io/ipfs/${resp.data.IpfsHash}`;
}

// 3. Upload JSON metadata to Pinata
async function uploadJsonToPinata(json: any, name: string) {
  const url = 'https://api.pinata.cloud/pinning/pinJSONToIPFS';
  const resp = await axios.post(url, {
    pinataContent: json,
    pinataMetadata: { name }
  }, {
    headers: {
      'Content-Type': 'application/json',
      pinata_api_key: PINATA_API_KEY!,
      pinata_secret_api_key: PINATA_SECRET_API_KEY!
    }
  });
  return `https://ipfs.io/ipfs/${resp.data.IpfsHash}`;
}

// 4. Render certificate text onto the base image
async function drawCertificate(
  buf: Buffer,
  programme: string,
  level: string,
  certId: string
): Promise<Buffer> {
  const img = await Jimp.read(buf);
  const fontR  = await Jimp.loadFont(FONT_REGULAR_PATH);
  const fontSB = await Jimp.loadFont(FONT_SEMIBOLD_PATH);
  const m = 80;

  img.print(fontSB, m, img.bitmap.height - m - 0, { text: programme.toUpperCase() });
  img.print(fontR,  m, img.bitmap.height/2 + m*1.5, { text: level.toUpperCase() });

  const tag = `#${certId}`;
  const wSB = Jimp.measureText(fontSB, tag);
  img.print(fontSB, img.bitmap.width - wSB - m, img.bitmap.height - m, { text: tag });

  return img.getBufferAsync(Jimp.MIME_JPEG);
}

// 5. Create a Candy Machine for N items
async function createCandyMachine(n: number) {
  const settings: CreateCandyMachineInput<DefaultCandyGuardSettings> = {
    itemsAvailable:       toBigNumber(n),
    sellerFeeBasisPoints: 1000,
    symbol:               'Encode',
    maxEditionSupply:     toBigNumber(0),
    isMutable:            true,
    creators: [
      { address: wallet.publicKey, share: 100 }
    ],
    collection: {
      address:          new PublicKey(COLLECTION_MINT!),
      updateAuthority:  wallet
    }
  };

  const { candyMachine } = await metaplex.candyMachines().create(settings);
  return candyMachine.address.toString();
}

// 6. Bulk‑load all URIs into the machine
async function loadItems(cmId: string, uris: string[]) {
  const cm = await metaplex
    .candyMachines()
    .findByAddress({ address: new PublicKey(cmId) });

  const items = uris.map((uri, i) => ({
    name: `Encode Certificate #${i + 1}`,
    uri
  }));

  await metaplex
    .candyMachines()
    .insertItems({ candyMachine: cm, items }, { commitment: 'finalized' });
}

// ─── Main Flow ──────────────────────────────────────────────────────────────────
(async () => {
  // 1) Grab next batch
  const records = await fetchBatch();
  if (records.length === 0) {
    console.log('No Ready Sol records to process.');
    return;
  }
  console.log(`Processing batch of ${records.length} records…`);

  // 2) Prep & upload each certificate
  const metadataUris: string[] = [];
  for (const rec of records) {
    const f       = rec.fields as unknown as Fields;
    const imgUrl  = f['Certificate image (from 📺 Programmes)'][0].url;
    const prog    = f['Programme name (from 📺 Programmes)'][0];
    const lvl     = f['Achievement level'];
    const certId  = f['Certificate ID'];

    // fetch base image + draw
    const rawBuf = Buffer.from((await axios.get(imgUrl, { responseType:'arraybuffer' })).data);
    const outBuf = await drawCertificate(rawBuf, prog, lvl, certId);

    // upload image
    const ipfsImg = await uploadToPinata(outBuf, `NFT_${certId}.jpg`);
    // upload JSON
    const meta = {
      name: `Encode Certificate #${certId}`,
      description: 'Encode Club NFT Certificate',
      image: ipfsImg,
      attributes: [
        { trait_type: 'Programme', value: prog },
        { trait_type: 'Level', value: lvl }
      ]
    };
    const ipfsMeta = await uploadJsonToPinata(meta, `MD_${certId}.json`);

    // save to Airtable
    await base(TABLE_NAME!).update(rec.id, {
      'IPFS Image':    ipfsImg,
      'IPFS Metadata': ipfsMeta
    });
    console.log(` → Uploaded record ${rec.id}`);

    metadataUris.push(ipfsMeta);
  }

  // 3) Create & load Candy Machine
  console.log('Creating Candy Machine…');
  const cmId = await createCandyMachine(records.length);
  console.log(`Candy Machine: ${cmId}`);

  console.log('Loading items…');
  await loadItems(cmId, metadataUris);
  console.log('All items loaded.');

  // 4) Final update to SPL Loaded
  for (const rec of records) {
    await base(TABLE_NAME!).update(rec.id, {
      'Candy Machine ID':   cmId,
      'Certificate Status': 'SPL Loaded'
    });
    console.log(` → Record ${rec.id} → SPL Loaded`);
  }

  console.log('✅ CloudPt1 complete.');
})();
