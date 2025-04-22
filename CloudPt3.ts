// transferAndEmail CloudPt3

import Airtable from 'airtable';
import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { Connection, Keypair, PublicKey, sendAndConfirmTransaction } from '@solana/web3.js';
import { Metaplex, keypairIdentity } from '@metaplex-foundation/js';
import dotenv from 'dotenv'
dotenv.config()


const { AIRTABLE_API_KEY, BASE_ID, TABLE_NAME, QUICKNODE_RPC, SENDGRID_API_KEY, SOLANA_SECRET_KEY } = process.env


if (!AIRTABLE_API_KEY) throw new Error("Missing AIRTABLE_API_KEY")
if (!BASE_ID)          throw new Error("Missing BASE_ID")
if (!TABLE_NAME)       throw new Error("Missing TABLE_NAME")
if (!QUICKNODE_RPC)    throw new Error("Missing QUICKNODE_RPC")
if (!SENDGRID_API_KEY) throw new Error("Missing SENDGRID_API_KEY")
if (!SOLANA_SECRET_KEY) throw new Error("Missing SOLANA_SECRET_KEY")


const base = new Airtable({ apiKey: AIRTABLE_API_KEY }).base(BASE_ID)



const connection = new Connection(QUICKNODE_RPC, { commitment: 'finalized' });
const secretKey = Uint8Array.from(JSON.parse(SOLANA_SECRET_KEY!));
const wallet    = Keypair.fromSecretKey(secretKey);
const metaplex   = Metaplex.make(connection).use(keypairIdentity(wallet));

// ─── FIELDS SHAPE ───────────────────────────────────────────────────────────────
interface Fields {
  'Certificate Status':           string;
  'Link to NFT':                  string;
  'ETH address (from ☃️ People)': string;
  'Email (from ☃️ People)':       string;
  'Programme name (from 📺 Programmes)': string[];
}

// ─── FETCH ONE “SPL Minted” RECORD ─────────────────────────────────────────────
async function fetchOneToTransfer(): Promise<Airtable.Record<Airtable.FieldSet> | null> {
  const [rec] = await base(TABLE_NAME!)
    .select({
      filterByFormula: "{Certificate Status}='SPL Minted'",
      maxRecords: 1
    })
    .firstPage();
  return rec || null;
}

// ─── TRANSFER NFT ───────────────────────────────────────────────────────────────
async function transferNFT(mintAddr: string, to: PublicKey): Promise<string> {
  // Find on‐chain NFT
  const nft = await metaplex.nfts().findByMint({ mintAddress: new PublicKey(mintAddr) });
  if (!nft) throw new Error(`NFT ${mintAddr} not found`);

  // Build & send transfer
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
  const builder = await metaplex.nfts().builders().transfer({
    nftOrSft:      nft,
    toOwner:       to,
    authority:     wallet
  });
  const tx      = builder.toTransaction({ blockhash, lastValidBlockHeight });
  tx.feePayer   = wallet.publicKey;
  const sig     = await sendAndConfirmTransaction(connection, tx, [wallet]);

  return sig;
}

// ─── SEND EMAIL ────────────────────────────────────────────────────────────────
async function sendEmail(
  toEmail: string,
  programmeName: string,
  firstName: string,
  txLink: string,
  solAddress: string
) {
  const html = `<div>
    <p>Hey ${firstName},</p>
    <p>🎉 Your Encode Club NFT for <strong>${programmeName}</strong> is now in your wallet <code>${solAddress}</code>.</p>
    <p>🔗 <a href="${txLink}" target="_blank">View the transfer transaction</a></p>
    <p>📢 Now show it off! Tweet it at <a href="https://twitter.com/encodeclub" target="_blank">@encodeclub</a> and we'll retweet.</p>
    <p>Thanks for being part of Encode Club! 🚀</p>
  </div>`;

  await axios.post('https://api.sendgrid.com/v3/mail/send', {
    personalizations: [{ to: [{ email: toEmail }] }],
    from:             { email: 'nfts@encode.club' },
    subject:          `Your Encode Club NFT is on its way!`,
    content:          [{ type: 'text/html', value: html }]
  }, {
    headers: {
      Authorization: `Bearer ${SENDGRID_API_KEY}`,
      'Content-Type': 'application/json'
    }
  });
}

// ─── MAIN ───────────────────────────────────────────────────────────────────────
(async () => {
  const rec = await fetchOneToTransfer();
  if (!rec) {
    console.log('No records with Certificate Status = SPL Minted');
    return;
  }

  const f      = rec.fields as unknown as Fields;
  const link   = f['Link to NFT'];
  const toAddr = f['ETH address (from ☃️ People)'];
  const email  = f['Email (from ☃️ People)'];
  const prog   = f['Programme name (from 📺 Programmes)'][0];
  const first  = email.split('@')[0];  // crude first name

  // Extract mint address from explorer link
  const mintAddr = link.split('/address/')[1].split('?')[0];

  console.log(`Transferring NFT ${mintAddr} → ${toAddr}...`);
  const sig = await transferNFT(mintAddr, new PublicKey(toAddr));
  const txLink = `https://explorer.solana.com/tx/${sig}?cluster=mainnet-beta`;
  console.log(`Transfer tx: ${sig}`);

  // Update Airtable
  await base(TABLE_NAME).update(rec.id, {
    'TXN':                 txLink,
    'Certificate Status':  'Success'
  });

  console.log(`Sending email to ${email}...`);
  await sendEmail(email, prog, first, txLink, toAddr);

  console.log(`✅ Completed for record ${rec.id}`);
})();
