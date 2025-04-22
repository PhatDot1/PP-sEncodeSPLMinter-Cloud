# Patrick's Encode Solana Minter - Metaplex

ts-node Orchestrator.ts runs in cloud - important data always held in airtable to minimise on-chain querying and cached memory.

Part 1 handles: initializing all of the images, hosting on IPFS, initializing minter, loading NFT's into minter.

Part 2 handles the minting of NFT's.

Part 3 handles sending the NFT's to the recipients address + sending them a confirmation email.

Feel free to refactor code further so components can be individually maintained. 


As previously stated, due to the NFT metadatas and images being mostly the same, for cost reduction I highly reccomend a SFT approach. See the SFT folder for a working and tested example SFT programme (solana version of a smart contract) and minting script.